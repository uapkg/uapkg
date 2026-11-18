import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHECKSUM_FILE,
  CHECKSUM_SIGNATURE,
  parseChecksums,
  serializeCatalogEntry,
  validateCurrentEntry,
  validateEntry,
  type CatalogEntry,
} from './ReleaseContract.ts';

export interface CatalogRecord {
  entry: CatalogEntry;
  checksums: Buffer;
  signature: Buffer;
}
export interface CatalogAttempt {
  directory: string;
  previous: string | null;
  push: () => boolean;
  close: () => void;
}
export interface CatalogAdapter {
  begin: () => CatalogAttempt;
}

/** Each attempt starts from the current remote head. Never overwrite a historical record. */
export function publishCatalog(
  record: CatalogRecord,
  adapter: CatalogAdapter,
  attempts = 5,
): { changed: boolean; attempts: number } {
  const entry = validateCurrentEntry(record.entry);
  parseChecksums(record.checksums.toString('utf8'), entry.product, entry.version, entry.files);
  if (!record.signature.length) throw new Error('A verified checksum signature is required.');
  const files = new Map<string, Buffer>([
    ['entry.json', Buffer.from(serializeCatalogEntry(entry))],
    [CHECKSUM_FILE, record.checksums],
    [CHECKSUM_SIGNATURE, record.signature],
  ]);
  for (let count = 1; count <= attempts; count += 1) {
    const attempt = adapter.begin();
    try {
      const directory = path.join(attempt.directory, entry.product, entry.version);
      const present = [...files].filter(([name]) => existsSync(path.join(directory, name)));
      if (present.length) {
        const matches = (name: string, bytes: Buffer): boolean => {
          const existing = readFileSync(path.join(directory, name));
          if (name !== 'entry.json') return existing.equals(bytes);
          try {
            const previous = validateEntry(JSON.parse(existing.toString('utf8')));
            return (
              previous.schemaVersion === entry.schemaVersion &&
              previous.product === entry.product &&
              previous.version === entry.version &&
              previous.publishedAt === entry.publishedAt &&
              previous.tag === entry.tag &&
              JSON.stringify(previous.files) === JSON.stringify(entry.files)
            );
          } catch {
            return false;
          }
        };
        if (present.length !== files.size || present.some(([name, bytes]) => !matches(name, bytes)))
          throw new Error(`Immutable catalog record differs: ${entry.product}/${entry.version}.`);
        return { changed: false, attempts: count };
      }
      mkdirSync(directory, { recursive: true });
      for (const [name, bytes] of files) writeFileSync(path.join(directory, name), bytes);
      if (attempt.push()) return { changed: true, attempts: count };
    } finally {
      attempt.close();
    }
  }
  throw new Error(
    `Catalog branch changed during ${attempts} attempts. Retry catalog publication using the existing GitHub release.`,
  );
}

/** Requires the runner's GitHub credential helper; no tokens are written into this branch. */
export function createCatalogAdapter(
  repository: string,
  message = 'Publish verified release catalog record',
): CatalogAdapter {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Expected an exact GitHub repository.');
  const remote = `https://github.com/${repository}.git`;
  const branch = 'refs/heads/catalog-release';
  return {
    begin() {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'uapkg-catalog-'));
      const git = (args: string[], optional = false): string | null => {
        const result = spawnSync('git', args, {
          cwd: directory,
          encoding: 'utf8',
          windowsHide: true,
          env: { ...process.env, UAPKG_RELEASE_SECRET_KEY: undefined, GIT_TERMINAL_PROMPT: '0' },
        });
        if (result.error || result.status !== 0) {
          if (optional && !result.error) return null;
          throw new Error(`Catalog git operation failed: ${result.error?.message ?? result.stderr}`);
        }
        return result.stdout.trim();
      };
      const head = () => git(['ls-remote', '--heads', remote, branch])!.split(/\s+/)[0] || null;
      try {
        git(['init', '--quiet', '--initial-branch=catalog-release']);
        git(['remote', 'add', 'origin', remote]);
        const previous = head();
        if (previous) {
          git(['fetch', '--quiet', '--depth=1', 'origin', branch]);
          git(['checkout', '--quiet', '-B', 'catalog-release', 'FETCH_HEAD']);
        }
        return {
          directory,
          previous,
          push() {
            git(['add', '--all']);
            git([
              '-c',
              'user.name=github-actions[bot]',
              '-c',
              'user.email=41898282+github-actions[bot]@users.noreply.github.com',
              'commit',
              '--quiet',
              '-m',
              message,
            ]);
            if (git(['push', 'origin', `HEAD:${branch}`], true) !== null) return true;
            // Only branch contention is retryable. Permission/network failures surface.
            if (head() === previous) throw new Error('Catalog push failed without a concurrent branch update.');
            return false;
          },
          close() {
            rmSync(directory, { recursive: true, force: true });
          },
        };
      } catch (error) {
        rmSync(directory, { recursive: true, force: true });
        throw error;
      }
    },
  };
}
