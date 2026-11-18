import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

const root = path.resolve(import.meta.dirname, '../../..');
const artifact = readFileSync(path.join(root, 'docs/release-signing.pub'), 'utf8');
const catalog = readFileSync(path.join(root, 'docs/release-catalog-signing.pub'), 'utf8');
const other = readFileSync(path.join(root, 'tools/release/fixtures/artifact.pub'), 'utf8');
const encoded = (key: string) => key.trim().split(/\r?\n/).at(-1)!;

interface Scenario {
  name: string;
  environment?: NodeJS.ProcessEnv;
  trackedCatalog?: string;
  candidate?: { artifact?: string; missingDocs?: boolean };
  args?: string[];
  error?: string;
}

function removeFixture(fixture: string, temporaryRoot: string): void {
  const resolved = realpathSync(fixture);
  if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('uapkg-public-keys-'))
    throw new Error('Refusing to remove a directory outside the public-key test fixture.');
  rmSync(resolved, { recursive: true, force: true });
}

describe('standalone release verification-key check', () => {
  it.each<Scenario>([
    { name: 'matching keys' },
    {
      name: 'a mismatched artifact key',
      environment: { UAPKG_RELEASE_PUBLIC_KEY: other },
      error: 'UAPKG_RELEASE_PUBLIC_KEY does not match docs/release-signing.pub',
    },
    {
      name: 'a mismatched catalog key',
      environment: { UAPKG_CATALOG_PUBLIC_KEY: other },
      error: 'UAPKG_CATALOG_PUBLIC_KEY does not match docs/release-catalog-signing.pub',
    },
    {
      name: 'a missing artifact variable',
      environment: { UAPKG_RELEASE_PUBLIC_KEY: undefined },
      error: 'UAPKG_RELEASE_PUBLIC_KEY must contain a valid Minisign public key',
    },
    {
      name: 'a missing catalog variable',
      environment: { UAPKG_CATALOG_PUBLIC_KEY: undefined },
      error: 'UAPKG_CATALOG_PUBLIC_KEY must contain a valid Minisign public key',
    },
    {
      name: 'a malformed tracked catalog key',
      trackedCatalog: 'not-a-key',
      error: 'docs/release-catalog-signing.pub must contain a valid Minisign public key',
    },
    { name: 'matching keys in an explicit candidate root', candidate: {} },
    {
      name: 'a changed candidate key with a matching trusted checkout',
      candidate: { artifact: other },
      error: 'UAPKG_RELEASE_PUBLIC_KEY does not match docs/release-signing.pub',
    },
    {
      name: 'missing candidate documents',
      candidate: { missingDocs: true },
      error: 'ENOENT',
    },
    {
      name: 'surplus command arguments',
      args: ['unused-root', 'extra-root'],
      error: 'Usage: checkPublicKeys.ts [repository-root]',
    },
  ])('returns the expected command status for $name', ({ environment, trackedCatalog, candidate, args, error }) => {
    const temporaryRoot = realpathSync(os.tmpdir());
    const fixture = realpathSync(mkdtempSync(path.join(temporaryRoot, 'uapkg-public-keys-')));
    try {
      const directory = path.join(fixture, 'tools/release');
      mkdirSync(directory, { recursive: true });
      mkdirSync(path.join(fixture, 'docs'));
      writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
      writeFileSync(path.join(fixture, 'docs/release-signing.pub'), artifact);
      writeFileSync(path.join(fixture, 'docs/release-catalog-signing.pub'), trackedCatalog ?? catalog);
      const command = path.join(directory, 'checkPublicKeys.ts');
      cpSync(path.join(root, 'tools/release/checkPublicKeys.ts'), command);
      const candidateRoot = path.join(fixture, 'candidate');
      if (candidate) {
        mkdirSync(path.join(candidateRoot, 'tools/release'), { recursive: true });
        writeFileSync(
          path.join(candidateRoot, 'tools/release/checkPublicKeys.ts'),
          "throw new Error('Candidate code must never execute');\n",
        );
        if (!candidate.missingDocs) {
          mkdirSync(path.join(candidateRoot, 'docs'));
          writeFileSync(path.join(candidateRoot, 'docs/release-signing.pub'), candidate.artifact ?? artifact);
          writeFileSync(path.join(candidateRoot, 'docs/release-catalog-signing.pub'), catalog);
        }
      }
      const result = spawnSync(process.execPath, [command, ...(args ?? (candidate ? [candidateRoot] : []))], {
        cwd: os.tmpdir(),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
        env: {
          ...process.env,
          UAPKG_RELEASE_PUBLIC_KEY: encoded(artifact),
          UAPKG_CATALOG_PUBLIC_KEY: encoded(catalog),
          ...environment,
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(error ? 1 : 0);
      expect(result.stdout).toBe('');
      if (error) expect(result.stderr).toContain(error);
      else expect(result.stderr).toBe('');
    } finally {
      removeFixture(fixture, temporaryRoot);
    }
  });
});
