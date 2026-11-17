import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workspace = path.resolve(import.meta.dirname, '../..');
export const NODE_RELEASE_KEYRING_REVISION = '481637f813e912c4aa3622d7964ab426c97b8e8d';
export const NODE_RELEASE_KEYRING_SHA256 = '610b8d249da3d5733f5a128def2dd0294dbbf5b5713e6ca2529db8db419dee00';
const platforms = new Set([
  'win-x64',
  'win-arm64',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
  'linux-x64-musl',
]);

export interface OfficialNodeProvenance {
  schemaVersion: 1;
  version: string;
  platform: string;
  archive: string;
  url: string;
  sha256: string;
  executableSha256: string;
  checksumSignatureSha256: string;
  keyringRevision: string;
  keyringSha256: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function officialNodeIdentity(
  version: string,
  platform: string,
): { archive: string; url: string; directory: string } {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !platforms.has(platform))
    throw new Error('Official Node provisioning requires an exact stable version and a supported distribution target.');
  const directory = `node-v${version}-${platform}`;
  const archive = `${directory}.${platform.startsWith('win-') ? 'zip' : 'tar.xz'}`;
  return { archive, directory, url: `https://nodejs.org/dist/v${version}/${archive}` };
}

export function authenticatedArchiveHash(checksums: string, archive: string): string {
  const matches = checksums.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-f0-9]{64})\s{2}([^\s]+)$/.exec(line);
    return match?.[2] === archive ? [match[1]!] : [];
  });
  if (matches.length !== 1)
    throw new Error(
      `The signed upstream checksums must contain exactly one ${archive}. No runtime fallback is permitted.`,
    );
  return matches[0]!;
}

function checked(program: string, args: string[], cwd: string): void {
  const result = spawnSync(program, args, { cwd, stdio: 'inherit', windowsHide: true, timeout: 180_000 });
  if (result.error || result.status !== 0)
    throw new Error(`${program} failed: ${result.error?.message ?? result.status}.`);
}

async function download(url: string, maximumBytes: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000), redirect: 'error' });
  if (!response.ok || !response.body)
    throw new Error(
      `Official Node download failed: ${url} (HTTP ${response.status}). No runtime fallback is permitted.`,
    );
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximumBytes) throw new Error(`Official Node download exceeded its size limit: ${url}.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function extract(archive: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  if (archive.endsWith('.zip') && process.platform !== 'win32')
    checked('unzip', ['-q', archive, '-d', destination], destination);
  else checked('tar', ['-xf', archive, '-C', destination], destination);
}

/** Runs on the trusted Ubuntu provisioning job; only Node's signed official archives are accepted. */
export async function provisionOfficialNode(platform: string, output: string): Promise<OfficialNodeProvenance> {
  const version = readFileSync(path.join(workspace, '.node-version'), 'utf8').trim();
  const identity = officialNodeIdentity(version, platform);
  const root = path.resolve(output);
  mkdirSync(root, { recursive: true });
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'uapkg-official-node-'));
  try {
    const keyring = await download(
      `https://raw.githubusercontent.com/nodejs/release-keys/${NODE_RELEASE_KEYRING_REVISION}/gpg/pubring.kbx`,
      1024 * 1024,
    );
    if (sha256(keyring) !== NODE_RELEASE_KEYRING_SHA256)
      throw new Error('The pinned Node release keyring checksum differs.');
    const keyringPath = path.join(root, 'nodejs-keyring.kbx');
    writeFileSync(keyringPath, keyring);
    const signature = await download(`https://nodejs.org/dist/v${version}/SHASUMS256.txt.asc`, 1024 * 1024);
    const signaturePath = path.join(root, 'SHASUMS256.txt.asc');
    writeFileSync(signaturePath, signature);
    // --homedir isolates user trust databases; the only trusted keys are the pinned upstream keyring.
    const verified = spawnSync(
      'gpgv',
      ['--homedir', scratch, '--keyring', keyringPath, '--output', '-', signaturePath],
      { cwd: scratch, encoding: 'utf8', timeout: 30_000, windowsHide: true },
    );
    if (verified.error || verified.status !== 0)
      throw new Error(
        `Official Node checksum signature verification failed: ${verified.error?.message ?? verified.stderr}`,
      );
    const expected = authenticatedArchiveHash(verified.stdout, identity.archive);
    const bytes = await download(identity.url, 256 * 1024 * 1024);
    if (sha256(bytes) !== expected)
      throw new Error('Official Node archive checksum differs from the authenticated upstream checksum.');
    const archivePath = path.join(root, identity.archive);
    writeFileSync(archivePath, bytes);
    const executable = `${identity.directory}/${platform.startsWith('win-') ? 'node.exe' : 'bin/node'}`;
    const binary = spawnSync(
      platform.startsWith('win-') && process.platform !== 'win32' ? 'unzip' : 'tar',
      platform.startsWith('win-') && process.platform !== 'win32'
        ? ['-p', archivePath, executable]
        : ['-xOf', archivePath, executable],
      { cwd: scratch, maxBuffer: 256 * 1024 * 1024, timeout: 120_000, windowsHide: true },
    );
    if (binary.error || binary.status !== 0 || binary.stdout.length === 0)
      throw new Error(
        `Could not inspect the official Node executable: ${binary.error?.message ?? binary.stderr.toString()}`,
      );
    const provenance: OfficialNodeProvenance = {
      schemaVersion: 1,
      version,
      platform,
      archive: identity.archive,
      url: identity.url,
      sha256: expected,
      executableSha256: sha256(binary.stdout),
      checksumSignatureSha256: sha256(signature),
      keyringRevision: NODE_RELEASE_KEYRING_REVISION,
      keyringSha256: NODE_RELEASE_KEYRING_SHA256,
    };
    writeFileSync(path.join(root, 'node-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
    return provenance;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function readOfficialNodeProvenance(file: string): OfficialNodeProvenance {
  const provenance = JSON.parse(readFileSync(file, 'utf8')) as OfficialNodeProvenance;
  const version = readFileSync(path.join(workspace, '.node-version'), 'utf8').trim();
  const identity = officialNodeIdentity(version, provenance.platform);
  if (
    provenance.schemaVersion !== 1 ||
    provenance.version !== version ||
    provenance.archive !== identity.archive ||
    provenance.url !== identity.url ||
    provenance.keyringRevision !== NODE_RELEASE_KEYRING_REVISION ||
    provenance.keyringSha256 !== NODE_RELEASE_KEYRING_SHA256 ||
    ![provenance.sha256, provenance.executableSha256, provenance.checksumSignatureSha256].every((value) =>
      /^[a-f0-9]{64}$/.test(value),
    )
  )
    throw new Error('Official Node provenance does not match the pinned release and trust anchor.');
  return provenance;
}

/** Bind packaging to the executable authenticated by the separate upstream-verification job. */
export function verifyOfficialNodeRuntime(expectedPlatform?: string): OfficialNodeProvenance {
  const file = process.env.UAPKG_NODE_PROVENANCE;
  if (!file)
    throw new Error('Native release builds require verified official Node provenance (UAPKG_NODE_PROVENANCE).');
  const provenance = readOfficialNodeProvenance(file);
  if (
    provenance.version !== process.versions.node ||
    (expectedPlatform !== undefined && provenance.platform !== expectedPlatform) ||
    sha256(readFileSync(process.execPath)) !== provenance.executableSha256
  )
    throw new Error('The executing Node runtime differs from the verified official distribution.');
  return provenance;
}

export function activateOfficialNode(bundle: string, output: string): string {
  const root = path.resolve(bundle);
  const provenancePath = path.join(root, 'node-provenance.json');
  const provenance = readOfficialNodeProvenance(provenancePath);
  const archivePath = path.join(root, provenance.archive);
  if (
    sha256(readFileSync(archivePath)) !== provenance.sha256 ||
    sha256(readFileSync(path.join(root, 'SHASUMS256.txt.asc'))) !== provenance.checksumSignatureSha256 ||
    sha256(readFileSync(path.join(root, 'nodejs-keyring.kbx'))) !== provenance.keyringSha256
  )
    throw new Error('The verified official Node provisioning bundle was modified.');
  const destination = path.resolve(output);
  const identity = officialNodeIdentity(provenance.version, provenance.platform);
  if (existsSync(path.join(destination, identity.directory)))
    throw new Error('Official Node extraction requires a fresh destination.');
  extract(archivePath, destination);
  const binaryDirectory = path.join(
    destination,
    identity.directory,
    provenance.platform.startsWith('win-') ? '' : 'bin',
  );
  const executable = path.join(binaryDirectory, provenance.platform.startsWith('win-') ? 'node.exe' : 'node');
  if (sha256(readFileSync(executable)) !== provenance.executableSha256)
    throw new Error('Extracted official Node executable differs.');
  if (process.platform !== 'win32') chmodSync(executable, 0o755);
  if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, `${binaryDirectory}\n`);
  if (process.env.GITHUB_ENV)
    appendFileSync(
      process.env.GITHUB_ENV,
      `UAPKG_NODE_PROVENANCE=${provenancePath}\nUAPKG_OFFICIAL_NODE=${executable}\n`,
    );
  return executable;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    const [operation, input, output] = process.argv.slice(2);
    if (!input || !output) throw new Error('Expected provision <platform> <output> or activate <bundle> <output>.');
    if (operation === 'provision') await provisionOfficialNode(input, output);
    else if (operation === 'activate') process.stdout.write(`${activateOfficialNode(input, output)}\n`);
    else throw new Error('Expected provision or activate.');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
