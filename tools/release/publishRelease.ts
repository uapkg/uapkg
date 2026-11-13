import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORMS = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
const KINDS = ['cli', 'launcher', 'bundle'];

interface ReleaseArtifact {
  kind: string;
  platform: string;
  fileName: string;
  sha256: string;
  size: number;
}

interface ReleaseCatalog {
  schemaVersion: number;
  cliVersion: string;
  launcherVersion: string;
  artifacts: ReleaseArtifact[];
}

/** Refuse publication until all platform payloads exist and match the catalog. */
export function verifyReleasePayloads(directory: string): ReleaseCatalog {
  const catalog = JSON.parse(readFileSync(path.join(directory, 'release.json'), 'utf8')) as ReleaseCatalog;
  if (
    catalog.schemaVersion !== 1 ||
    !catalog.cliVersion ||
    !catalog.launcherVersion ||
    !Array.isArray(catalog.artifacts)
  ) {
    throw new Error('Release metadata is missing its version identities or artifact list.');
  }
  const expected = new Set(PLATFORMS.flatMap((platform) => KINDS.map((kind) => `${platform}/${kind}`)));
  const names = new Set<string>();
  for (const artifact of catalog.artifacts) {
    if (!expected.delete(`${artifact.platform}/${artifact.kind}`)) {
      throw new Error(`Unexpected or duplicate release artifact: ${artifact.platform}/${artifact.kind}`);
    }
    if (
      typeof artifact.fileName !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*\.tar\.gz$/.test(artifact.fileName) ||
      names.has(artifact.fileName)
    ) {
      throw new Error('Release artifact filenames must be unique archive basenames.');
    }
    names.add(artifact.fileName);
    const archive = path.join(directory, artifact.fileName);
    if (!statSync(archive).isFile() || statSync(archive).size !== artifact.size) {
      throw new Error(`Release artifact size mismatch: ${artifact.fileName}`);
    }
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
    if (digest !== artifact.sha256) {
      throw new Error(`Release artifact checksum mismatch: ${artifact.fileName}`);
    }
  }
  if (expected.size > 0) {
    throw new Error(`Release is missing required artifacts: ${[...expected].join(', ')}`);
  }
  return catalog;
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, UAPKG_RELEASE_SECRET_KEY: undefined },
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed${result.error ? `: ${result.error.message}` : ` with exit code ${result.status}`}`,
    );
  }
}

export function signRelease(): ReleaseCatalog {
  const workspace = fileURLToPath(new URL('../../', import.meta.url));
  const directory = path.resolve(workspace, process.env.UAPKG_RELEASE_DIRECTORY ?? 'dist/release');
  const publicKey = process.env.UAPKG_RELEASE_PUBLIC_KEY?.trim();
  const secretKey = process.env.UAPKG_RELEASE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    throw new Error('Publishing requires UAPKG_RELEASE_PUBLIC_KEY and UAPKG_RELEASE_SECRET_KEY. See docs/launcher.md.');
  }
  const catalog = verifyReleasePayloads(directory);
  const packageManifest = JSON.parse(readFileSync(path.join(workspace, 'packages/uapkg/package.json'), 'utf8')) as {
    version: string;
  };
  if (catalog.cliVersion !== packageManifest.version) {
    throw new Error('Release artifacts do not match the current CLI package version. Rebuild before publishing.');
  }
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'uapkg-release-signing-'));
  try {
    const keyFile = path.join(temporaryDirectory, 'minisign.key');
    writeFileSync(keyFile, secretKey, { mode: 0o600 });
    const metadata = path.join(directory, 'release.json');
    run(
      'minisign',
      [
        '-S',
        '-s',
        keyFile,
        '-m',
        metadata,
        '-t',
        `UAPKG CLI ${catalog.cliVersion}; launcher ${catalog.launcherVersion}`,
      ],
      workspace,
    );
    run('minisign', ['-V', '-H', '-P', publicKey, '-m', metadata], workspace);
  } finally {
    // This directory is created by mkdtemp above; it never comes from caller input.
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return catalog;
}

export function publishRelease(): void {
  signRelease();
  const workspace = fileURLToPath(new URL('../../', import.meta.url));
  // Changesets owns npm publication, tags, and its existing GitHub Release flow.
  // Verification and signing deliberately happen before any publication.
  run('vp', ['exec', 'changeset', 'publish'], workspace);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    publishRelease();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
