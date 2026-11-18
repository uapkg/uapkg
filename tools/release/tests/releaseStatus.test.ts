import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { changeReleaseStatus, type ReleaseStatusRequest } from '../releaseStatus.ts';
import { type CatalogAdapter } from '../publishCatalog.ts';
import { type CatalogEntry, HISTORICAL_PLATFORMS, releaseTag, type ReleaseProduct } from '../ReleaseContract.ts';

const directories: string[] = [];
function temporary(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'uapkg-release-status-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const timestamp = '2026-11-18T12:34:56Z';
const status = { at: timestamp, reason: 'Broken release' };
function remote(product: ReleaseProduct = 'cli') {
  const directory = temporary();
  const relative = path.join(product, '1.2.3', 'entry.json');
  const file = path.join(directory, relative);
  const entry: CatalogEntry = {
    schemaVersion: 1,
    product,
    version: '1.2.3',
    publishedAt: '2026-11-01T12:34:56Z',
    tag: releaseTag(product, '1.2.3'),
    files: [...HISTORICAL_PLATFORMS],
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`);
  writeFileSync(path.join(path.dirname(file), 'SHASUMS256.txt'), 'original checksum bytes');
  writeFileSync(path.join(path.dirname(file), 'SHASUMS256.txt.minisig'), 'original signature bytes');
  let revision = 0;
  let beforePush: (() => void) | undefined;
  const adapter: CatalogAdapter = {
    begin() {
      const work = temporary();
      cpSync(directory, work, { recursive: true });
      const previous = revision;
      return {
        directory: work,
        previous: String(previous),
        close() {},
        push() {
          const callback = beforePush;
          beforePush = undefined;
          callback?.();
          if (revision !== previous) return false;
          cpSync(work, directory, { recursive: true });
          revision++;
          return true;
        },
      };
    },
  };
  const request: ReleaseStatusRequest = { product, version: '1.2.3', operation: 'yank', reason: status.reason };
  return {
    directory,
    entry,
    file,
    adapter,
    request,
    read: () => JSON.parse(readFileSync(file, 'utf8')) as CatalogEntry,
    race(callback: () => void) {
      beforePush = callback;
    },
  };
}

describe('release catalog status changes', () => {
  it.each(['cli', 'launcher'] as const)('sets and independently clears both statuses for %s', (product) => {
    const target = remote(product);
    expect(changeReleaseStatus(target.request, target.adapter, timestamp)).toEqual({ changed: true, attempts: 1 });
    expect(target.read()).toEqual({ ...target.entry, yanked: status });
    changeReleaseStatus({ ...target.request, operation: 'quarantine' }, target.adapter, timestamp);
    expect(target.read()).toEqual({ ...target.entry, yanked: status, quarantined: status });
    changeReleaseStatus({ ...target.request, operation: 'unyank', reason: undefined }, target.adapter);
    expect(target.read()).toEqual({ ...target.entry, quarantined: status });
    changeReleaseStatus({ ...target.request, operation: 'unquarantine', reason: undefined }, target.adapter);
    expect(target.read()).toEqual(target.entry);
    expect(readFileSync(path.join(path.dirname(target.file), 'SHASUMS256.txt'), 'utf8')).toBe(
      'original checksum bytes',
    );
    expect(readFileSync(path.join(path.dirname(target.file), 'SHASUMS256.txt.minisig'), 'utf8')).toBe(
      'original signature bytes',
    );
  });
  it('preserves timestamps for identical requests and makes repeated clear operations no-ops', () => {
    const target = remote();
    changeReleaseStatus(target.request, target.adapter, timestamp);
    expect(changeReleaseStatus(target.request, target.adapter, '2026-11-19T00:00:00Z')).toEqual({
      changed: false,
      attempts: 1,
    });
    expect(target.read().yanked).toEqual(status);
    const request = { ...target.request, operation: 'unyank' as const };
    changeReleaseStatus(request, target.adapter);
    expect(changeReleaseStatus(request, target.adapter)).toEqual({ changed: false, attempts: 1 });
  });
  it('updates a changed reason and preserves an unrelated null status', () => {
    const target = remote();
    writeFileSync(target.file, JSON.stringify({ ...target.entry, quarantined: null }));
    changeReleaseStatus(target.request, target.adapter, timestamp);
    changeReleaseStatus({ ...target.request, reason: ' Corrected reason ' }, target.adapter, '2026-11-19T00:00:00Z');
    expect(target.read()).toEqual({
      ...target.entry,
      quarantined: null,
      yanked: { at: '2026-11-19T00:00:00Z', reason: 'Corrected reason' },
    });
  });
  it.each([undefined, '', '  '])('requires a reason when setting status (%s)', (reason) => {
    const target = remote();
    for (const operation of ['yank', 'quarantine'] as const)
      expect(() => changeReleaseStatus({ ...target.request, operation, reason }, target.adapter)).toThrow('reason');
    expect(target.read()).toEqual(target.entry);
  });
  it('rejects missing releases, invalid inputs and mismatched entry identities', () => {
    const target = remote();
    expect(() => changeReleaseStatus({ ...target.request, version: '1.2.4' }, target.adapter)).toThrow(
      'not in the catalog',
    );
    expect(() => changeReleaseStatus({ ...target.request, version: '../1.2.3' }, target.adapter)).toThrow(
      'exact version',
    );
    expect(() => changeReleaseStatus({ ...target.request, operation: 'erase' as never }, target.adapter)).toThrow(
      'Expected yank',
    );
    writeFileSync(target.file, JSON.stringify({ ...target.entry, version: '1.2.4', tag: releaseTag('cli', '1.2.4') }));
    expect(() => changeReleaseStatus(target.request, target.adapter)).toThrow('identity');
  });
  it('rejects symbolic catalog paths before changing external files', () => {
    const target = remote();
    const outside = temporary();
    const external = path.join(outside, 'entry.json');
    writeFileSync(external, JSON.stringify(target.entry));
    const work = temporary();
    mkdirSync(path.join(work, 'cli'));
    symlinkSync(outside, path.join(work, 'cli', '1.2.3'), process.platform === 'win32' ? 'junction' : 'dir');
    const adapter: CatalogAdapter = {
      begin: () => ({ directory: work, previous: null, close() {}, push: () => true }),
    };
    expect(() => changeReleaseStatus(target.request, adapter)).toThrow('ordinary directories');
    expect(JSON.parse(readFileSync(external, 'utf8'))).toEqual(target.entry);
  });
  it('rejects metadata too large for downstream ingestion before pushing it', () => {
    const target = remote();
    expect(() => changeReleaseStatus({ ...target.request, reason: 'x'.repeat(16_384) }, target.adapter)).toThrow(
      '16,384-byte',
    );
    expect(target.read()).toEqual(target.entry);
  });
  it('accepts the exact catalog byte limit with multibyte reason text', () => {
    const target = remote();
    const overhead = Buffer.byteLength(
      `${JSON.stringify({ ...target.entry, yanked: { at: timestamp, reason: '' } }, null, 2)}\n`,
    );
    const available = 16_384 - overhead;
    const reason = 'é'.repeat(Math.floor(available / 2)) + 'x'.repeat(available % 2);
    expect(changeReleaseStatus({ ...target.request, reason }, target.adapter, timestamp).changed).toBe(true);
    expect(readFileSync(target.file).length).toBe(16_384);
  });
  it('retries concurrent operations without losing the other status and retains its original timestamp', () => {
    const target = remote();
    target.race(() => changeReleaseStatus({ ...target.request, operation: 'quarantine' }, target.adapter, timestamp));
    expect(changeReleaseStatus(target.request, target.adapter, '2026-11-19T00:00:00Z')).toEqual({
      changed: true,
      attempts: 2,
    });
    expect(target.read()).toEqual({
      ...target.entry,
      quarantined: status,
      yanked: { ...status, at: '2026-11-19T00:00:00Z' },
    });
  });
  it('keeps a concurrent new release and bounds persistent branch contention', () => {
    const target = remote();
    target.race(() => {
      writeFileSync(path.join(target.directory, 'new-release.json'), 'new release');
      changeReleaseStatus({ ...target.request, operation: 'quarantine' }, target.adapter, timestamp);
    });
    changeReleaseStatus(target.request, target.adapter, timestamp);
    expect(existsSync(path.join(target.directory, 'new-release.json'))).toBe(true);
    const blocked: CatalogAdapter = {
      begin() {
        return { ...target.adapter.begin(), push: () => false };
      },
    };
    expect(() => changeReleaseStatus({ ...target.request, operation: 'unyank' }, blocked, timestamp, 2)).toThrow(
      '2 attempts',
    );
  });
});
