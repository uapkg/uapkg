import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveActiveUapkgProfileRoot } from '@uapkg/common';
import type { PublicKey } from 'openpgp';
import { list } from 'tar';
import {
  authenticateNodeChecksum,
  NodeChecksumSignatureError,
  type NodeChecksumTarget,
} from '#node-version-manager/NodeChecksum.ts';
import { ReleaseKeyStore } from '#node-version-manager/ReleaseKeyStore.ts';

const origin = 'https://nodejs.org/dist';
const exactPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const majorPattern = /^(0|[1-9]\d*)$/;

export interface NodeResolutionOptions {
  readonly pins?: Readonly<Record<string, string>>;
  readonly frozen?: boolean;
  readonly offline?: boolean;
  readonly refresh?: boolean;
}

export interface NodeVersionManagerOptions {
  readonly cacheRoot?: string;
  readonly fetch?: typeof fetch;
}

function runtimePlatform(): string {
  const arch = process.arch;
  if (arch !== 'x64' && arch !== 'arm64') throw new Error('Unsupported Node runtime architecture: ' + arch);
  if (process.platform === 'win32') return 'win-' + arch;
  if (process.platform === 'darwin') return 'darwin-' + arch;
  if (process.platform !== 'linux') throw new Error('Unsupported Node runtime platform: ' + process.platform);
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string }; sharedObjects?: string[] };
  if (report.header?.glibcVersionRuntime) return 'linux-' + arch;
  if (arch === 'x64' && report.sharedObjects?.some((path) => /(?:^|\/)ld-musl-[^/]+\.so\.1$/.test(path)))
    return 'linux-x64-musl';
  throw new Error('Unsupported Linux runtime ABI for Node on ' + arch);
}

async function atomicWrite(path: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const stage = path + '.' + randomUUID();
  try {
    await writeFile(stage, data, { mode: 0o600 });
    await rename(stage, path);
  } finally {
    await rm(stage, { force: true });
  }
}

async function fileHash(path: string): Promise<string | undefined> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export class NodeVersionManager {
  private readonly root: string;
  private readonly request: typeof fetch;
  private readonly releaseKeys: ReleaseKeyStore;

  constructor(options: NodeVersionManagerOptions = {}) {
    this.root = options.cacheRoot ?? join(resolveActiveUapkgProfileRoot(), 'cache', 'node-runtimes');
    this.request = options.fetch ?? fetch;
    this.releaseKeys = new ReleaseKeyStore(this.root, (url, limit) => this.download(url, limit));
  }

  async resolveVersion(selector: string, options: NodeResolutionOptions = {}): Promise<string> {
    const exact = exactPattern.test(selector);
    if (!exact && !majorPattern.test(selector))
      throw new Error('Node selector must be a major or exact stable version: ' + selector);
    const pinned = options.pins && Object.hasOwn(options.pins, selector) ? options.pins[selector] : undefined;
    if (pinned !== undefined) {
      if (!exactPattern.test(pinned) || (exact ? pinned !== selector : pinned.split('.')[0] !== selector))
        throw new Error('Invalid locked Node version for ' + selector);
      if (options.frozen || !options.refresh) return pinned;
    }
    if (options.frozen)
      throw new Error(
        'No locked Node runtime for ' + selector + '. Approve or install without --frozen to record a pin.',
      );
    const indexPath = join(this.root, 'index.json');
    let index: string;
    if (options.offline) {
      try {
        index = await readFile(indexPath, 'utf8');
      } catch {
        throw new Error('No cached official Node index to resolve ' + selector + ' offline.');
      }
    } else {
      index = (await this.download(origin + '/index.json', 8_000_000)).toString('utf8');
    }
    const entries: unknown = JSON.parse(index);
    if (!Array.isArray(entries)) throw new Error('Invalid official Node release index.');
    const versions: string[] = [];
    for (const item of entries) {
      if (typeof item?.version !== 'string' || !item.version.startsWith('v')) continue;
      const value = item.version.slice(1);
      if (exactPattern.test(value) && (exact ? value === selector : value.split('.')[0] === selector))
        versions.push(value);
    }
    if (!versions.length) throw new Error('No official stable Node release matches ' + selector);
    versions.sort((a, b) => {
      const left = a.split('.').map(Number);
      const right = b.split('.').map(Number);
      return right[0]! - left[0]! || right[1]! - left[1]! || right[2]! - left[2]!;
    });
    if (!options.offline) await atomicWrite(indexPath, index);
    return versions[0]!;
  }

  async ensureRuntime(version: string, options: { readonly offline?: boolean } = {}): Promise<string> {
    if (!exactPattern.test(version)) throw new Error('Expected an exact stable Node version: ' + version);
    const platform = runtimePlatform();
    const windows = platform.startsWith('win-');
    const prefix = 'node-v' + version + '-' + platform;
    const asset = windows ? platform + '/node.exe' : prefix + '.tar.gz';
    const base = origin + '/v' + version + '/';
    const cache = join(this.root, version, platform);
    await mkdir(cache, { recursive: true });
    const sha256 = await this.releaseChecksum(cache, base, { version, asset }, options.offline === true);
    const executable = join(cache, windows ? 'node.exe' : 'node');
    const payload = windows ? executable : join(cache, 'release.tar.gz');
    if ((await fileHash(payload)) !== sha256) {
      if (options.offline)
        throw new Error('Verified Node ' + version + ' for ' + platform + ' is unavailable offline.');
      const bytes = await this.download(base + asset, 256 * 1024 * 1024);
      if (createHash('sha256').update(bytes).digest('hex') !== sha256)
        throw new Error('Official Node runtime archive checksum mismatch for ' + asset);
      await atomicWrite(payload, bytes);
    }
    if (!windows) await this.activateUnixBinary(payload, prefix, executable, sha256);
    return executable;
  }

  private async activateUnixBinary(payload: string, prefix: string, executable: string, sha256: string): Promise<void> {
    // The extracted executable is derived again from authenticated archive bytes on each use.
    const archive = payload + '.' + randomUUID();
    try {
      await copyFile(payload, archive);
      if ((await fileHash(archive)) !== sha256) throw new Error('Cached Node archive changed during verification.');
      let found = 0;
      const chunks: Buffer[] = [];
      await list({
        file: archive,
        strict: true,
        onReadEntry(entry) {
          if (entry.path !== prefix + '/bin/node' || entry.type !== 'File') return;
          found++;
          if (entry.size > 256 * 1024 * 1024) {
            found++;
            return;
          }
          entry.on('data', (data: Buffer) => chunks.push(data));
        },
      });
      if (found !== 1 || !chunks.length) throw new Error('No unique Node executable in the signed distribution.');
      const binary = Buffer.concat(chunks);
      if ((await fileHash(executable)) !== createHash('sha256').update(binary).digest('hex'))
        await atomicWrite(executable, binary);
      await chmod(executable, 0o700);
    } finally {
      await rm(archive, { force: true });
    }
  }

  private async releaseChecksum(
    cache: string,
    base: string,
    target: NodeChecksumTarget,
    offline: boolean,
  ): Promise<string> {
    const filename = 'SHASUMS256.txt.asc';
    const signedPath = join(cache, filename);
    let signed: Buffer | undefined;
    try {
      signed = await readFile(signedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (offline) throw new Error('Official Node checksums are unavailable offline: ' + signedPath, { cause: error });
    }

    let keys = await this.releaseKeys.load({ offline });
    const verify = (data: Buffer, trusted: readonly PublicKey[]) =>
      authenticateNodeChecksum(data.toString('utf8'), target, trusted);
    if (signed) {
      try {
        return await verify(signed, keys);
      } catch (error) {
        if (offline) throw error;
        // The release may have been re-signed, or the local checksum file may be damaged.
      }
    }
    const published = await this.download(base + filename, 1_048_576);
    let digest: string;
    try {
      digest = await verify(published, keys);
    } catch (error) {
      if (!(error instanceof NodeChecksumSignatureError)) throw error;
      // A new signer or renewed certificate can appear inside the cache freshness window.
      keys = await this.releaseKeys.load({ force: true });
      digest = await verify(published, keys);
    }
    await atomicWrite(signedPath, published);
    return digest;
  }

  private async download(url: string, limit: number): Promise<Buffer> {
    const response = await this.request(url, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body)
      throw new Error('Official Node download failed (' + response.status + '): ' + url);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > limit) throw new Error('Official Node download exceeded size limit: ' + url);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
