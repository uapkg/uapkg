import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertExactVersion,
  assertProduct,
  validateEntry,
  validateReleaseStatus,
  type CatalogEntry,
  type ReleaseProduct,
} from './ReleaseContract.ts';
import type { CatalogAdapter } from './publishCatalog.ts';

export const RELEASE_STATUS_OPERATIONS = ['yank', 'unyank', 'quarantine', 'unquarantine'] as const;
export type ReleaseStatusOperation = (typeof RELEASE_STATUS_OPERATIONS)[number];

export interface ReleaseStatusRequest {
  product: ReleaseProduct;
  version: string;
  operation: ReleaseStatusOperation;
  reason?: string;
}

export function updateReleaseEntry(directory: string, request: ReleaseStatusRequest, now: string): boolean {
  assertProduct(request.product);
  assertExactVersion(request.version);
  if (!(RELEASE_STATUS_OPERATIONS as readonly unknown[]).includes(request.operation))
    throw new Error('Expected yank, unyank, quarantine, or unquarantine.');
  const key = request.operation === 'yank' || request.operation === 'unyank' ? 'yanked' : 'quarantined';
  const clear = request.operation === 'unyank' || request.operation === 'unquarantine';
  const status = clear ? undefined : validateReleaseStatus({ at: now, reason: request.reason?.trim() });
  const file = path.join(directory, request.product, request.version, 'entry.json');
  if (!existsSync(file)) throw new Error(`Release is not in the catalog: ${request.product}/${request.version}.`);
  for (const parent of [directory, path.dirname(path.dirname(file)), path.dirname(file)]) {
    const info = lstatSync(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Catalog paths must be ordinary directories.');
  }
  const info = lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Catalog entry must be an ordinary file.');
  const entry: CatalogEntry = validateEntry(JSON.parse(readFileSync(file, 'utf8')));
  if (entry.product !== request.product || entry.version !== request.version)
    throw new Error('Catalog entry differs from the requested release identity.');
  if (clear) {
    if (!Object.hasOwn(entry, key)) return false;
    delete entry[key];
  } else {
    if (entry[key]?.reason === status!.reason) return false;
    entry[key] = status;
  }
  // The other status and original file list retain their catalog values.
  // In particular, quarantine never empties the durable publication receipt.
  const bytes = Buffer.from(`${JSON.stringify(entry, null, 2)}\n`);
  if (bytes.length > 16_384) throw new Error('Catalog entry exceeds the 16,384-byte publication limit.');
  writeFileSync(file, bytes);
  return true;
}

/** A retry refreshes the branch head, preserving concurrent publications and the other status. */
export function changeReleaseStatus(
  request: ReleaseStatusRequest,
  adapter: CatalogAdapter,
  now = new Date().toISOString(),
  attempts = 5,
): { changed: boolean; attempts: number } {
  for (let count = 1; count <= attempts; count++) {
    const attempt = adapter.begin();
    try {
      if (!updateReleaseEntry(attempt.directory, request, now)) return { changed: false, attempts: count };
      if (attempt.push()) return { changed: true, attempts: count };
    } finally {
      attempt.close();
    }
  }
  throw new Error(`Catalog branch changed during ${attempts} attempts. Retry the release status operation.`);
}
