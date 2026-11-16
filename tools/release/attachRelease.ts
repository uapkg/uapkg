import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'semver';
import {
  CHECKSUM_FILE,
  CHECKSUM_SIGNATURE,
  PLATFORMS,
  artifactName,
  parseChecksums,
  releaseTag,
  validateEntry,
  type CatalogEntry,
  type ReleaseProduct,
} from './ReleaseContract.ts';
import { signRelease, writeChecksums } from './publishRelease.ts';

export interface RemoteRelease {
  tagName: string;
  isDraft: boolean;
  publishedAt: string;
  assets: { name: string }[];
}
export interface AttachmentAdapter {
  getRelease: (tag: string) => RemoteRelease | null;
  createRelease: (product: ReleaseProduct, version: string) => RemoteRelease;
  download: (tag: string, name: string, directory: string) => void;
  verifySignature: (checksums: string, signature: string) => void;
  sign: (directory: string) => void;
  upload: (tag: string, file: string) => void;
}
export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
type Execute = (command: string, args: string[]) => CommandResult;

export function createAttachmentAdapter(
  repository: string,
  publicKey: string,
  revision: string,
  execute: Execute = (command, args) =>
    spawnSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, UAPKG_RELEASE_SECRET_KEY: undefined },
    }),
): AttachmentAdapter {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Expected an exact GitHub repository.');
  const checked = (command: string, args: string[]): string => {
    const result = execute(command, args);
    if (result.error || result.status !== 0)
      throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
    return result.stdout;
  };
  const getRelease = (tag: string): RemoteRelease | null => {
    const result = execute('gh', ['api', `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`]);
    if (!result.error && result.status !== 0 && /HTTP 404/.test(result.stderr)) return null;
    if (result.error || result.status !== 0)
      throw new Error(`Could not read release: ${result.error?.message ?? result.stderr}`);
    const release = JSON.parse(result.stdout) as {
      tag_name: string;
      draft: boolean;
      published_at: string;
      assets: { name: string }[];
    };
    return {
      tagName: release.tag_name,
      isDraft: release.draft,
      publishedAt: release.published_at,
      assets: release.assets,
    };
  };
  return {
    getRelease,
    createRelease(product, version) {
      if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Release creation requires the verified source commit.');
      const tag = releaseTag(product, version);
      checked('gh', [
        'release',
        'create',
        tag,
        '--repo',
        repository,
        '--target',
        revision,
        '--title',
        `UAPKG ${product} ${version}`,
        '--notes',
        `Independent ${product} release. Verify SHASUMS256.txt with the UAPKG artifact signing key.`,
        '--latest=false',
        ...(parse(version)!.prerelease.length ? ['--prerelease'] : []),
      ]);
      const release = getRelease(tag);
      if (!release) throw new Error('Created release is unavailable.');
      return release;
    },
    download(tag, name, directory) {
      checked('gh', ['release', 'download', tag, '--repo', repository, '--pattern', name, '--dir', directory]);
    },
    verifySignature(checksums, signature) {
      if (!publicKey) throw new Error('Verification requires UAPKG_RELEASE_PUBLIC_KEY.');
      checked('minisign', ['-V', '-H', '-P', publicKey, '-m', checksums, '-x', signature]);
    },
    sign: signRelease,
    upload(tag, file) {
      checked('gh', ['release', 'upload', tag, file, '--repo', repository]);
    },
  };
}

function checkRelease(release: RemoteRelease | null, product: ReleaseProduct, version: string): RemoteRelease {
  const tag = releaseTag(product, version);
  if (!release || release.tagName !== tag || release.isDraft || !Array.isArray(release.assets))
    throw new Error(`Expected the published GitHub release ${tag}.`);
  if (new Set(release.assets.map((asset) => asset.name)).size !== release.assets.length)
    throw new Error('Duplicate GitHub asset names.');
  return release;
}
export function expectedAssets(product: ReleaseProduct, version: string): string[] {
  return [...PLATFORMS.map((platform) => artifactName(product, version, platform)), CHECKSUM_FILE, CHECKSUM_SIGNATURE];
}
export function hasCompleteRelease(release: RemoteRelease | null, product: ReleaseProduct, version: string): boolean {
  if (!release) return false;
  checkRelease(release, product, version);
  const names = new Set(release.assets.map((asset) => asset.name));
  return expectedAssets(product, version).every((name) => names.has(name));
}
/** Resume a partial upload without replacing any bytes, then verify the remote result. */
export function attachReleaseAssets(directory: string, adapter: AttachmentAdapter): string[] {
  const build = writeChecksums(directory);
  const tag = releaseTag(build.product, build.version);
  const release = checkRelease(
    adapter.getRelease(tag) ?? adapter.createRelease(build.product, build.version),
    build.product,
    build.version,
  );
  const existing = new Set(release.assets.map((asset) => asset.name));
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'uapkg-release-attachment-'));
  const uploaded: string[] = [];
  try {
    for (const name of expectedAssets(build.product, build.version).filter((name) => name !== CHECKSUM_SIGNATURE)) {
      if (!existing.has(name)) continue;
      adapter.download(tag, name, scratch);
      if (!readFileSync(path.join(directory, name)).equals(readFileSync(path.join(scratch, name))))
        throw new Error(
          `Existing release asset differs: ${name}. Assets are immutable; retry with original artifacts or publish a new version.`,
        );
    }
    if (existing.has(CHECKSUM_SIGNATURE)) {
      adapter.download(tag, CHECKSUM_SIGNATURE, scratch);
      adapter.verifySignature(path.join(directory, CHECKSUM_FILE), path.join(scratch, CHECKSUM_SIGNATURE));
      cpSync(path.join(scratch, CHECKSUM_SIGNATURE), path.join(directory, CHECKSUM_SIGNATURE));
    } else {
      adapter.sign(directory);
      adapter.verifySignature(path.join(directory, CHECKSUM_FILE), path.join(directory, CHECKSUM_SIGNATURE));
    }
    for (const name of expectedAssets(build.product, build.version)) {
      if (existing.has(name)) continue;
      adapter.upload(tag, path.join(directory, name));
      uploaded.push(name);
    }
    return uploaded;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Reconstruct catalog publication from remote assets, without a rebuild or npm lookup. */
export function verifyPublishedRelease(
  directory: string,
  product: ReleaseProduct,
  version: string,
  adapter: AttachmentAdapter,
): CatalogEntry {
  const release = checkRelease(adapter.getRelease(releaseTag(product, version)), product, version);
  if (!hasCompleteRelease(release, product, version)) throw new Error('Published release is missing required assets.');
  for (const name of [CHECKSUM_FILE, CHECKSUM_SIGNATURE]) adapter.download(release.tagName, name, directory);
  adapter.verifySignature(path.join(directory, CHECKSUM_FILE), path.join(directory, CHECKSUM_SIGNATURE));
  const checksums = parseChecksums(
    readFileSync(path.join(directory, CHECKSUM_FILE), 'utf8'),
    product,
    version,
    PLATFORMS,
  );
  for (const [name, expected] of checksums) {
    adapter.download(release.tagName, name, directory);
    const file = path.join(directory, name);
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== expected)
      throw new Error(`Published archive checksum mismatch: ${name}`);
    rmSync(file);
  }
  return validateEntry({
    schemaVersion: 1,
    product,
    version,
    publishedAt: release.publishedAt,
    tag: release.tagName,
    files: [...PLATFORMS],
  });
}
