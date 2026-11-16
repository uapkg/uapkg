import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, lstatSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHECKSUM_FILE,
  PLATFORMS,
  artifactName,
  assertExactVersion,
  assertProduct,
  parseChecksums,
} from './ReleaseContract.ts';
import type { ReleaseBuild } from './ReleaseArtifacts.ts';

/** Internal build evidence gates signing; it is never published as client metadata. */
export function verifyReleasePayloads(directory: string): ReleaseBuild {
  const build = JSON.parse(readFileSync(path.join(directory, 'build.json'), 'utf8')) as ReleaseBuild;
  if (build.schemaVersion !== 1 || !Array.isArray(build.artifacts)) throw new Error('Invalid native build evidence.');
  assertProduct(build.product);
  assertExactVersion(build.version);
  const expected = new Set<string>(PLATFORMS);
  for (const artifact of build.artifacts) {
    if (!expected.delete(artifact.platform)) throw new Error('Unexpected or duplicate release platform.');
    if (artifact.fileName !== artifactName(build.product, build.version, artifact.platform))
      throw new Error('Noncanonical release archive name.');
    const archive = path.join(directory, artifact.fileName);
    const stat = lstatSync(archive);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.size)
      throw new Error(`Release artifact size mismatch: ${artifact.fileName}`);
    if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== artifact.sha256)
      throw new Error(`Release artifact checksum mismatch: ${artifact.fileName}`);
  }
  if (expected.size) throw new Error('Release is missing required platforms.');
  return build;
}

export function writeChecksums(directory: string): ReleaseBuild {
  const build = verifyReleasePayloads(directory);
  const checksums = [...build.artifacts]
    .sort((a, b) => a.fileName.localeCompare(b.fileName, 'en'))
    .map((artifact) => `${artifact.sha256}  ${artifact.fileName}\n`)
    .join('');
  parseChecksums(checksums, build.product, build.version, PLATFORMS);
  writeFileSync(path.join(directory, CHECKSUM_FILE), checksums);
  return build;
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, UAPKG_RELEASE_SECRET_KEY: undefined },
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${result.error?.message ?? `exit ${result.status}`}`);
}

export function signRelease(directory: string): ReleaseBuild {
  const publicKey = process.env.UAPKG_RELEASE_PUBLIC_KEY?.trim();
  const secretKey = process.env.UAPKG_RELEASE_SECRET_KEY;
  if (!publicKey || !secretKey)
    throw new Error('Signing requires UAPKG_RELEASE_PUBLIC_KEY and UAPKG_RELEASE_SECRET_KEY.');
  const build = writeChecksums(directory);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'uapkg-release-signing-'));
  try {
    const key = path.join(scratch, 'minisign.key');
    writeFileSync(key, secretKey, { mode: 0o600 });
    const checksums = path.join(directory, CHECKSUM_FILE);
    run('minisign', ['-S', '-s', key, '-m', checksums, '-t', `UAPKG ${build.product} ${build.version}`], directory);
    run('minisign', ['-V', '-H', '-P', publicKey, '-m', checksums], directory);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return build;
}

/** npm publication remains independent of native artifacts and their signing keys. */
export function publishRelease(): void {
  const workspace = fileURLToPath(new URL('../../', import.meta.url));
  run('vp', ['exec', 'changeset', 'publish', '--no-git-tag'], workspace);
  // Library tags remain useful, but native publication exclusively owns the CLI tag.
  // Existing tags can point to an older commit when a library version did not change.
  if (process.env.GITHUB_ACTIONS === 'true') {
    const tags: string[] = [];
    for (const entry of readdirSync(path.join(workspace, 'packages'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = JSON.parse(
        readFileSync(path.join(workspace, 'packages', entry.name, 'package.json'), 'utf8'),
      ) as { name: string; version: string; private?: boolean };
      if (manifest.private || manifest.name === '@uapkg/cli') continue;
      assertExactVersion(manifest.version);
      const tag = `${manifest.name}@${manifest.version}`;
      const existing = spawnSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], {
        cwd: workspace,
        encoding: 'utf8',
        windowsHide: true,
      });
      if (existing.error || existing.status !== 0) throw new Error('Could not inspect existing library tags.');
      if (existing.stdout.trim()) continue;
      run('git', ['tag', tag], workspace);
      tags.push(`refs/tags/${tag}`);
    }
    if (tags.length) run('git', ['push', 'origin', ...tags], workspace);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    publishRelease();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
