import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { authenticateNodeChecksum, readNodeReleaseKey } from '../src/NodeChecksum.ts';
import { NodeVersionManager } from '../src/NodeVersionManager.ts';
import { keyringArchive, mockKeyringRepository } from './fixtures/keyringArchive.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'uapkg-node-manager-'));
  roots.push(cacheRoot);
  return cacheRoot;
}

async function manager(request: typeof fetch) {
  return new NodeVersionManager({ fetch: request, cacheRoot: await tempRoot() });
}

describe('managed Node selection', () => {
  it('selects the highest stable patch for the requested major, reuses reviewed pins, and refreshes explicitly', async () => {
    const fetchIndex = vi.fn(async () =>
      Response.json([
        { version: 'v23.9.0' },
        { version: 'v22.9.0' },
        { version: 'v22.11.0' },
        { version: 'v22.12.0-rc.1' },
      ]),
    );
    const node = await manager(fetchIndex);
    expect(await node.resolveVersion('22')).toBe('22.11.0');
    expect(await node.resolveVersion('22', { offline: true })).toBe('22.11.0');
    const pins = { '22': '22.2.1' };
    expect(await node.resolveVersion('22', { pins })).toBe('22.2.1');
    expect(await node.resolveVersion('22', { pins, frozen: true, refresh: true })).toBe('22.2.1');
    expect(await node.resolveVersion('22', { pins, refresh: true })).toBe('22.11.0');
    expect(fetchIndex).toHaveBeenCalledTimes(2);
  });

  it('fails an invalid, missing frozen, or cross-major pin before network access', async () => {
    const request = vi.fn<typeof fetch>();
    const node = await manager(request);
    await expect(node.resolveVersion('22.1')).rejects.toThrow('major or exact');
    await expect(node.resolveVersion('22', { frozen: true })).rejects.toThrow('No locked');
    await expect(node.resolveVersion('22', { pins: { '22': '23.1.0' } })).rejects.toThrow('Invalid locked');
    await expect(node.resolveVersion('22', { offline: true })).rejects.toThrow('offline');
    await expect(node.ensureRuntime('22.1.0', { offline: true })).rejects.toThrow('offline');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('Node upstream release signatures', () => {
  const target = { version: '26.13.1', asset: 'win-x64/node.exe' };
  const checksum = 'f5109dc868ec38703ad8f305e0aceece717cb60d4889873f434017af4e96cccb';
  const signed = () => readFile(new URL('./fixtures/SHASUMS256.txt.asc', import.meta.url), 'utf8');
  const key = () => readFile(new URL('./fixtures/node-release-key.asc', import.meta.url));
  const fingerprint = '5BE8A3F6C8A5C01D106C0AD820B1A390B168D356';

  it('verifies the signed upstream asset digest and requires an exact platform entry', async () => {
    const keys = [await readNodeReleaseKey(await key(), fingerprint)];
    expect(await authenticateNodeChecksum(await signed(), target, keys)).toBe(checksum);
    await expect(authenticateNodeChecksum(await signed(), { ...target, version: '26.13.2' }, keys)).rejects.toThrow(
      'requested release 26.13.2',
    );
    await expect(
      authenticateNodeChecksum(await signed(), { ...target, asset: 'win-unknown/node.exe' }, keys),
    ).rejects.toThrow('No unique');
  });

  it('rejects altered checksums and substituted key data', async () => {
    const keys = [await readNodeReleaseKey(await key(), fingerprint)];
    await expect(
      authenticateNodeChecksum((await signed()).replace(checksum, 'a'.repeat(64)), target, keys),
    ).rejects.toThrow();
    await expect(readNodeReleaseKey(await key(), 'B'.repeat(40))).rejects.toThrow('fingerprint');
  });

  it('rejects substitute runtime bytes, and refuses a missing binary during offline replay', async () => {
    const root = await tempRoot();
    const repository = mockKeyringRepository();
    const revision = '1'.repeat(40);
    repository.publish(
      revision,
      await keyringArchive(root, revision, [{ fingerprint, armored: (await key()).toString() }]),
    );
    const upstream = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://nodejs.org/dist/')) return repository.fetch(input);
      if (url.endsWith('SHASUMS256.txt.asc')) return new Response(await signed());
      return new Response('unverified runtime');
    });
    const node = await manager(upstream);
    await expect(node.ensureRuntime('26.13.1')).rejects.toThrow('checksum mismatch');
    const before = upstream.mock.calls.length;
    await expect(node.ensureRuntime('26.13.1', { offline: true })).rejects.toThrow('offline');
    expect(upstream).toHaveBeenCalledTimes(before);
  });
});
