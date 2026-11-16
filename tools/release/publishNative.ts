import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertExactVersion, assertProduct, CHECKSUM_FILE, CHECKSUM_SIGNATURE, releaseTag } from './ReleaseContract.ts';
import {
  attachReleaseAssets,
  createAttachmentAdapter,
  hasCompleteRelease,
  verifyPublishedRelease,
} from './attachRelease.ts';
import { createCatalogAdapter, publishCatalog } from './publishCatalog.ts';

export function publishNative(args: string[]): void {
  const [command, product, version, directory] = args;
  assertProduct(product);
  assertExactVersion(version);
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const adapter = createAttachmentAdapter(
    repository,
    process.env.UAPKG_RELEASE_PUBLIC_KEY?.trim() ?? '',
    process.env.GITHUB_SHA ?? '',
  );
  if (command === 'status') {
    const complete = hasCompleteRelease(adapter.getRelease(releaseTag(product, version)), product, version);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `complete=${complete}\n`);
    process.stdout.write(`Complete native release: ${complete}\n`);
    return;
  }
  if (command !== 'publish')
    throw new Error('Expected status or publish, product, version, and optional build directory.');
  if (!hasCompleteRelease(adapter.getRelease(releaseTag(product, version)), product, version)) {
    if (!directory) throw new Error('Incomplete release requires its original assembled build directory.');
    const build = JSON.parse(readFileSync(path.join(directory, 'build.json'), 'utf8')) as {
      product: string;
      version: string;
    };
    if (build.product !== product || build.version !== version)
      throw new Error('Build identity differs from the requested release.');
    attachReleaseAssets(path.resolve(directory), adapter);
  }
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'uapkg-published-release-'));
  try {
    const entry = verifyPublishedRelease(scratch, product, version, adapter);
    const result = publishCatalog(
      {
        entry,
        checksums: readFileSync(path.join(scratch, CHECKSUM_FILE)),
        signature: readFileSync(path.join(scratch, CHECKSUM_SIGNATURE)),
      },
      createCatalogAdapter(repository),
    );
    process.stdout.write(`${result.changed ? 'Published' : 'Confirmed'} catalog record ${product}/${version}.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    publishNative(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
