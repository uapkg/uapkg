import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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

/** npm may accept publication before its public registry serves the version. */
export async function waitForNpmPublication(
  version: string,
  isPublished: (version: string) => boolean,
  {
    pause = delay,
    progress = (message: string) => process.stdout.write(`${message}\n`),
  }: {
    pause?: (milliseconds: number) => Promise<void>;
    progress?: (message: string) => void;
  } = {},
): Promise<void> {
  assertExactVersion(version);
  const attempts = 31;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // The adapter returns false only for E404; authentication, network, and
    // malformed-response errors propagate without an additional attempt.
    if (isPublished(version)) return;
    if (attempt === attempts) break;
    progress(`Waiting for @uapkg/cli@${version} on npm (${attempt}/${attempts}); retrying in 10 seconds.`);
    await pause(10_000);
  }
  throw new Error(
    `@uapkg/cli@${version} is still absent from https://registry.npmjs.org/ after 31 checks and five minutes of waiting. Confirm npm publication, then retry release attachment with the original retained native artifacts.`,
  );
}

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
        '--prefer-online',
        '--fetch-retries=0',
        '--fetch-timeout=10000',
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
  if (!adapter.isPublished(version)) {
    throw new Error(
      `Cannot attach native assets: @uapkg/cli@${version} is not published at https://registry.npmjs.org/. Complete npm publication, then rerun release attachment.`,
    );
  }
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
    await waitForNpmPublication(version, adapter.isPublished);
    // Reuse the exact version confirmed above rather than adding a lookup
    // outside the bounded visibility check. Other callers retain the guard.
    const uploaded = attachReleaseAssets(directory, version, {
      ...adapter,
      isPublished: (requested) => requested === version,
    });
    process.stdout.write(`Attached ${uploaded.length} missing release assets.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
