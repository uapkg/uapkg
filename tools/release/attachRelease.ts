import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmCliPath } from './NativeBuild.ts';
import { assertExactVersion } from './ReleaseArtifacts.ts';
import { signRelease, verifyReleasePayloads } from './publishRelease.ts';

interface RemoteRelease {
  tagName: string;
  isDraft: boolean;
  assets: { name: string }[];
}

export interface AttachmentAdapter {
  isPublished: (version: string) => boolean;
  getRelease: (tag: string) => RemoteRelease;
  download: (tag: string, name: string, directory: string) => void;
  verifySignature: (metadata: string, signature: string) => void;
  sign: () => void;
  upload: (tag: string, file: string) => void;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

type Execute = (command: string, args: string[]) => CommandResult;

/** All network operations are injectable; tests never contact or modify a release. */
export function createAttachmentAdapter(
  repository: string,
  publicKey: string,
  execute: Execute = (command, args) =>
    spawnSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
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
  return {
    isPublished(version) {
      const result = execute(process.execPath, [
        npmCliPath(),
        'view',
        `@uapkg/cli@${version}`,
        'version',
        '--json',
        '--registry=https://registry.npmjs.org/',
      ]);
      if (!result.error && result.status !== 0 && /\bE404\b/.test(`${result.stdout}\n${result.stderr}`)) return false;
      if (result.error || result.status !== 0)
        throw new Error(`Could not confirm npm publication: ${result.error?.message ?? result.stderr}`);
      if (JSON.parse(result.stdout) !== version) throw new Error('npm returned a different CLI version.');
      return true;
    },
    getRelease(tag) {
      return JSON.parse(
        checked('gh', ['release', 'view', tag, '--repo', repository, '--json', 'tagName,isDraft,assets']),
      ) as RemoteRelease;
    },
    download(tag, name, directory) {
      checked('gh', ['release', 'download', tag, '--repo', repository, '--pattern', name, '--dir', directory]);
    },
    verifySignature(metadata, signature) {
      if (!publicKey) throw new Error('Release attachment requires UAPKG_RELEASE_PUBLIC_KEY.');
      checked('minisign', ['-V', '-H', '-P', publicKey, '-m', metadata, '-x', signature]);
    },
    sign() {
      signRelease();
    },
    upload(tag, file) {
      // No --clobber: a concurrent uploader must fail rather than overwrite.
      checked('gh', ['release', 'upload', tag, file, '--repo', repository]);
    },
  };
}

/** Resume partial attachment, preserving every previously published asset. */
export function attachReleaseAssets(directory: string, version: string, adapter: AttachmentAdapter): string[] {
  assertExactVersion(version);
  const catalog = verifyReleasePayloads(directory);
  if (catalog.cliVersion !== version) throw new Error('Release metadata does not match the current CLI version.');
  if (!adapter.isPublished(version)) return [];
  const tag = `@uapkg/cli@${version}`;
  const release = adapter.getRelease(tag);
  if (release.tagName !== tag || release.isDraft || !Array.isArray(release.assets))
    throw new Error(`Expected the published GitHub release ${tag}.`);
  const existing = new Set(release.assets.map((asset) => asset.name));
  if (existing.size !== release.assets.length) throw new Error('The GitHub release contains duplicate asset names.');
  const metadata = path.join(directory, 'release.json');
  const signature = path.join(directory, 'release.json.minisig');
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'uapkg-release-attachment-'));
  const uploaded: string[] = [];
  try {
    // Check every conflict before uploading anything. Reruns must reuse the same
    // saved artifacts if rebuilding native executables changes their bytes.
    for (const name of [...catalog.artifacts.map((artifact) => artifact.fileName), 'release.json']) {
      if (!existing.has(name)) continue;
      adapter.download(tag, name, scratch);
      const local = path.join(directory, name);
      const remote = path.join(scratch, name);
      const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
      if (statSync(local).size !== statSync(remote).size || hash(local) !== hash(remote))
        throw new Error(
          `Existing release asset differs: ${name}. Assets are immutable; retry with the original saved artifacts or publish a new version.`,
        );
    }
    if (existing.has('release.json.minisig')) {
      adapter.download(tag, 'release.json.minisig', scratch);
      // Minisign trusted timestamps can differ after re-signing identical bytes.
      adapter.verifySignature(metadata, path.join(scratch, 'release.json.minisig'));
    } else {
      adapter.sign();
      adapter.verifySignature(metadata, signature);
    }
    for (const name of [
      ...catalog.artifacts.map((artifact) => artifact.fileName),
      'release.json',
      'release.json.minisig',
    ]) {
      if (existing.has(name)) continue;
      adapter.upload(tag, path.join(directory, name));
      uploaded.push(name);
    }
    return uploaded;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const workspace = fileURLToPath(new URL('../../', import.meta.url));
    const directory = path.resolve(workspace, process.env.UAPKG_RELEASE_DIRECTORY ?? 'dist/release');
    const version = (
      JSON.parse(readFileSync(path.join(workspace, 'packages/uapkg/package.json'), 'utf8')) as { version: string }
    ).version;
    const adapter = createAttachmentAdapter(
      process.env.GITHUB_REPOSITORY ?? '',
      process.env.UAPKG_RELEASE_PUBLIC_KEY?.trim() ?? '',
    );
    const uploaded = attachReleaseAssets(directory, version, adapter);
    process.stdout.write(`Attached ${uploaded.length} missing release assets.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
