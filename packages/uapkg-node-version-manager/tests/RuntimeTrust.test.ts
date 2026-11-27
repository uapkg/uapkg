import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCleartextMessage, enums, generateKey, reformatKey, revokeKey, sign, type PrivateKey } from 'openpgp';
import { create } from 'tar';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { NodeVersionManager } from '../src/NodeVersionManager.ts';
import { keyringArchive, mockKeyringRepository, type KeyringFixtureKey } from './fixtures/keyringArchive.ts';

const hour = 3_600_000;
const day = 24 * hour;
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function signer(name: string, expiresInSeconds?: number) {
  const pair = await generateKey({
    userIDs: [{ name }],
    type: 'ecc',
    curve: 'curve25519Legacy',
    format: 'object',
    date: new Date(Date.now() - 48 * hour),
    keyExpirationTime: expiresInSeconds,
    subkeys: [],
  });
  return { ...pair, fingerprint: pair.publicKey.getFingerprint().toUpperCase(), armored: pair.publicKey.armor() };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'node-key-rotation-'));
  roots.push(root);
  const keyRepository = mockKeyringRepository();
  const releases = new Map<string, string | Uint8Array>();
  const request = vi.fn<typeof fetch>((input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = releases.get(url);
    if (response === undefined) return keyRepository.fetch(input);
    return Promise.resolve(new Response(typeof response === 'string' ? response : new Uint8Array(response)));
  });
  const manager = () => new NodeVersionManager({ cacheRoot: join(root, 'cache'), fetch: request });
  let sequence = 0;
  return {
    manager,
    request,
    async update(keys: KeyringFixtureKey[] | Uint8Array) {
      const revision = (++sequence).toString(16).padStart(40, '0');
      keyRepository.publish(revision, keys instanceof Uint8Array ? keys : await keyringArchive(root, revision, keys));
    },
    async release(version: string, signingKey: PrivateKey, signedAt = new Date(Date.now() - hour)) {
      const binary = Buffer.from('Runtime fixture ' + version);
      let asset = 'win-' + process.arch + '/node.exe';
      let payload = binary;
      if (process.platform !== 'win32') {
        const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
        const musl = process.platform === 'linux' && !report.header.glibcVersionRuntime;
        const prefix = 'node-v' + version + '-' + process.platform + '-' + process.arch + (musl ? '-musl' : '');
        asset = prefix + '.tar.gz';
        const stage = await mkdtemp(join(root, 'release-'));
        await mkdir(join(stage, prefix, 'bin'), { recursive: true });
        await writeFile(join(stage, prefix, 'bin', 'node'), binary);
        await create({ cwd: stage, gzip: true, file: join(stage, asset), portable: true }, [prefix]);
        payload = await readFile(join(stage, asset));
      }
      const digest = createHash('sha256').update(payload).digest('hex');
      const message = await createCleartextMessage({
        text: digest + '  ' + asset + '\n' + 'e'.repeat(64) + '  node-v' + version + '.tar.gz',
      });
      const base = 'https://nodejs.org/dist/v' + version + '/';
      releases.set(base + 'SHASUMS256.txt.asc', await sign({ message, signingKeys: signingKey, date: signedAt }));
      releases.set(base + asset, payload);
      return binary;
    },
  };
}

describe('managed runtime trust after upstream key changes', () => {
  it('rejects a genuine signed document and executable copied from another release into the pinned cache', async () => {
    const host = await fixture();
    const original = await signer('Release signer');
    await host.update([original]);
    await host.release('24.1.0', original.privateKey);
    await host.release('24.2.0', original.privateKey);
    const node = host.manager();
    const older = await node.ensureRuntime('24.1.0');
    const requested = await node.ensureRuntime('24.2.0');
    await copyFile(older, requested);
    await copyFile(join(dirname(older), 'SHASUMS256.txt.asc'), join(dirname(requested), 'SHASUMS256.txt.asc'));
    const before = host.request.mock.calls.length;
    await expect(node.ensureRuntime('24.2.0', { offline: true })).rejects.toThrow('requested release 24.2.0');
    expect(host.request).toHaveBeenCalledTimes(before);
  });

  it.each(['revoked', 'removed'] as const)(
    'rejects a cached release offline after its signer is %s',
    async (change) => {
      const host = await fixture();
      const original = await signer('Original signer');
      const next = await signer('Rotated signer');
      await host.update([original]);
      const originalBytes = await host.release('24.1.0', original.privateKey);
      const node = host.manager();
      const installed = await node.ensureRuntime('24.1.0');
      expect(await readFile(installed)).toEqual(originalBytes);
      const revision: KeyringFixtureKey[] = [next];
      if (change === 'revoked') {
        const revoked = await revokeKey({
          key: original.privateKey,
          reasonForRevocation: { flag: enums.reasonForRevocation.keyCompromised, string: 'Compromised after signing' },
        });
        revision.push({ fingerprint: original.fingerprint, armored: revoked.publicKey });
      }
      await host.update(revision);
      const newBytes = await host.release('24.2.0', next.privateKey);
      // The snapshot is still fresh; seeing a new signer triggers a refresh in this same process.
      expect(await readFile(await node.ensureRuntime('24.2.0'))).toEqual(newBytes);
      const before = host.request.mock.calls.length;
      const offline = host.manager();
      await expect(offline.ensureRuntime('24.1.0', { offline: true })).rejects.toThrow(/signature|signer/i);
      expect(await readFile(await offline.ensureRuntime('24.2.0', { offline: true }))).toEqual(newBytes);
      expect(await readFile(installed)).toEqual(originalBytes);
      expect(host.request).toHaveBeenCalledTimes(before);
      if (change === 'revoked') {
        // Even if a future export restores the old certificate, the authenticated revocation still applies.
        await host.update([original, next]);
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(Date.now() + 31 * day));
        await node.ensureRuntime('24.2.0');
        await expect(host.manager().ensureRuntime('24.1.0', { offline: true })).rejects.toThrow(/signature|signer/i);
      }
    },
  );

  it('refreshes an extended certificate for the same fingerprint while its snapshot is still fresh', async () => {
    const host = await fixture();
    const original = await signer('Renewing signer', 24 * 60 * 60);
    await host.update([original]);
    await host.release('24.1.0', original.privateKey, new Date(Date.now() - 36 * hour));
    const node = host.manager();
    await node.ensureRuntime('24.1.0');
    const renewed = await reformatKey({
      privateKey: original.privateKey,
      userIDs: [{ name: 'Renewing signer' }],
      date: new Date(Date.now() - 2 * hour),
      keyExpirationTime: 7 * 24 * 60 * 60,
      format: 'object',
    });
    expect(renewed.publicKey.getFingerprint()).toBe(original.publicKey.getFingerprint());
    await host.update([{ fingerprint: original.fingerprint, armored: renewed.publicKey.armor() }]);
    const bytes = await host.release('24.2.0', renewed.privateKey);
    expect(await readFile(await node.ensureRuntime('24.2.0'))).toEqual(bytes);
  });

  it('fails a mandatory refresh on a malformed snapshot and preserves the last verified offline runtime', async () => {
    const host = await fixture();
    const original = await signer('Cached signer');
    await host.update([original]);
    const bytes = await host.release('24.1.0', original.privateKey);
    await host.manager().ensureRuntime('24.1.0');
    await host.update(Buffer.from('malformed key archive'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 31 * day));
    // Neither the existing signed checksum nor the previously verified binary authorizes a stale online fallback.
    await expect(host.manager().ensureRuntime('24.1.0')).rejects.toThrow();
    const before = host.request.mock.calls.length;
    expect(await readFile(await host.manager().ensureRuntime('24.1.0', { offline: true }))).toEqual(bytes);
    expect(host.request).toHaveBeenCalledTimes(before);
  });
});
