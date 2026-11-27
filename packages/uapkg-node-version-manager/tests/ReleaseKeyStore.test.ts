import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKey } from 'openpgp';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { NODE_RELEASE_KEYS_REVISION } from '../src/NodeReleaseKeys.ts';
import { ReleaseKeyStore } from '../src/ReleaseKeyStore.ts';
import { keyringArchive, mockKeyringRepository } from './fixtures/keyringArchive.ts';

const rootRevision = NODE_RELEASE_KEYS_REVISION;
const second = '2'.repeat(40);
const third = '3'.repeat(40);
const day = 24 * 60 * 60 * 1000;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'uapkg-release-key-store-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function downloader(request: typeof fetch) {
  return vi.fn(async (url: string) => {
    const response = await request(url);
    if (!response.ok) throw new Error('Upstream request failed');
    return Buffer.from(await response.arrayBuffer());
  });
}

async function fixture() {
  const armored = await readFile(new URL('./fixtures/node-release-key.asc', import.meta.url), 'utf8');
  const fingerprint = (await readKey({ armoredKey: armored })).getFingerprint().toUpperCase();
  const certificate = { fingerprint, armored };
  const service = mockKeyringRepository();
  service.publish(rootRevision, await keyringArchive(root, rootRevision, [certificate]));
  const download = downloader(service.fetch);
  return { download, service, certificate, store: new ReleaseKeyStore(root, download) };
}

it('fetches a complete inventory once, rechecks a known head when forced and verifies it offline', async () => {
  const { store, download, certificate } = await fixture();
  await expect(store.load({ offline: true })).rejects.toThrow('offline');
  expect(download).not.toHaveBeenCalled();
  const keys = await store.load();
  expect(keys.map((key) => key.getFingerprint().toUpperCase())).toEqual([certificate.fingerprint]);
  expect(download).toHaveBeenCalledTimes(3);
  await store.load();
  await store.load({ offline: true });
  expect(download).toHaveBeenCalledTimes(3);
  await store.load({ force: true });
  expect(download).toHaveBeenCalledTimes(4);
});

it('applies removals and rejects a rolled-back head without reactivating the previous generation', async () => {
  const { store, service, download } = await fixture();
  await store.load();
  service.publish(second, await keyringArchive(root, second, []));
  expect(await store.load({ force: true })).toEqual([]);
  download
    .mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: rootRevision } })),
    )
    .mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({
          status: 'behind',
          ahead_by: 0,
          behind_by: 1,
          base_commit: { sha: second },
          merge_base_commit: { sha: rootRevision },
        }),
      ),
    );
  await expect(store.load({ force: true })).rejects.toThrow(/rollback|divergent/);
  expect(download).toHaveBeenLastCalledWith(
    expect.stringContaining('/compare/' + second + '...' + rootRevision),
    expect.any(Number),
  );
  expect(await store.load({ offline: true })).toEqual([]);
});

it('rechecks on the first online use at 30 days and applies an upstream key withdrawal', async () => {
  const { store, service, download } = await fixture();
  const checkedAt = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(checkedAt);
  await store.load();
  service.publish(second, await keyringArchive(root, second, []));
  download.mockClear();

  clock.mockReturnValue(checkedAt + 30 * day - 1);
  expect(await store.load()).toHaveLength(1);
  clock.mockReturnValue(checkedAt + 30 * day);
  expect(await store.load({ offline: true })).toHaveLength(1);
  expect(download).not.toHaveBeenCalled();
  expect(await store.load()).toEqual([]);
  expect(await store.load({ offline: true })).toEqual([]);
});

it('never publishes a mismatched certificate or incomplete inventory', async () => {
  const { store, service, certificate } = await fixture();
  await store.load();
  service.publish(second, await keyringArchive(root, second, [{ ...certificate, fingerprint: 'F'.repeat(40) }]));
  await expect(store.load({ force: true })).rejects.toThrow(/fingerprint/);
  service.publish(third, await keyringArchive(root, third, [certificate, certificate]));
  await expect(store.load({ force: true })).rejects.toThrow(/duplicate/);
  expect(await store.load({ offline: true })).toHaveLength(1);
});

it.each(['README.md', 'key'])('rejects altered archive content against the official Git tree for %s', async (file) => {
  const { store, service, certificate } = await fixture();
  await store.load();
  const candidate = await keyringArchive(root, second, [certificate]);
  const path = file === 'key' ? 'keys/' + certificate.fingerprint + '.asc' : file;
  candidate.tree.find((entry) => entry.path === path)!.sha = 'f'.repeat(40);
  service.publish(second, candidate);
  await expect(store.load({ force: true })).rejects.toThrow(/blob|Git|inventory/i);
  expect(await store.load({ offline: true })).toHaveLength(1);
});

it('treats a future-dated cache as stale and fails closed on corruption and disabled TLS', async () => {
  const { store, download } = await fixture();
  await store.load();
  const file = join(root, 'release-keys/snapshots-v1/1.json');
  await writeFile(
    file + '.checked.json',
    JSON.stringify({ revision: rootRevision, checkedAt: Date.now() + 86_400_000 }),
  );
  download.mockClear();
  vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
  await expect(store.load()).rejects.toThrow('HTTPS certificate verification');
  expect(download).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  await store.load();
  expect(download).toHaveBeenCalledOnce();
  await writeFile(file, (await readFile(file, 'utf8')) + ' ');
  await expect(store.load({ force: true })).rejects.toThrow('integrity');
  await expect(store.load({ offline: true })).rejects.toThrow('integrity');
});

it('checks an expired copy online even when its filesystem timestamps are fresh', async () => {
  const { store, download } = await fixture();
  const checkedAt = Date.now() - 31 * day;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(checkedAt);
  await store.load();
  clock.mockRestore();
  const restored = join(root, 'restored');
  await cp(join(root, 'release-keys'), join(restored, 'release-keys'), { recursive: true });
  const file = join(restored, 'release-keys/snapshots-v1/1.json');
  const { mtimeMs } = await stat(file);
  expect(Date.now() - mtimeMs).toBeLessThan(60_000);
  const copy = new ReleaseKeyStore(restored, download);
  download.mockClear();
  await copy.load({ offline: true });
  expect(download).not.toHaveBeenCalled();
  await copy.load();
  expect(download).toHaveBeenCalledOnce();
  expect((await stat(file)).mtimeMs).toEqual(mtimeMs);
  const receipt = JSON.parse(await readFile(file + '.checked.json', 'utf8'));
  expect(receipt.checkedAt).toBeGreaterThan(checkedAt);
  await copy.load();
  expect(download).toHaveBeenCalledOnce();
});

it('checks online after a missing, malformed, or mismatched freshness receipt', async () => {
  const { store, download } = await fixture();
  await store.load();
  const receipt = join(root, 'release-keys/snapshots-v1/1.json.checked.json');
  for (const invalid of [undefined, '{', JSON.stringify({ revision: second, checkedAt: Date.now() })]) {
    if (invalid === undefined) await rm(receipt);
    else await writeFile(receipt, invalid);
    download.mockClear();
    expect(await store.load({ offline: true })).toHaveLength(1);
    expect(download).not.toHaveBeenCalled();
    expect(await store.load()).toHaveLength(1);
    expect(download).toHaveBeenCalledOnce();
  }
});

it('keeps the newer checked generation when an older concurrent download finishes last', async () => {
  const { store, service, certificate } = await fixture();
  await store.load();
  service.publish(second, await keyringArchive(root, second, [certificate]));
  let finish!: () => void;
  let arrived!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const other = new ReleaseKeyStore(
    root,
    downloader(async (input) => {
      const response = await service.fetch(input);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('codeload.github.com')) {
        arrived();
        await pending;
      }
      return response;
    }),
  );
  const first = other.load({ force: true });
  await requested;
  service.publish(third, await keyringArchive(root, third, []));
  try {
    expect(await store.load({ force: true })).toEqual([]);
  } finally {
    finish();
  }
  expect(await first).toEqual([]);
  expect(await other.load({ offline: true })).toEqual([]);
});
