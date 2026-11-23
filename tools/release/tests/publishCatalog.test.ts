import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { publishCatalog, type CatalogAdapter, type CatalogRecord } from '../publishCatalog.ts';
import { artifactName, HISTORICAL_PLATFORMS, PLATFORMS, releaseTag, type ReleaseProduct } from '../ReleaseContract.ts';
const directories: string[] = [];
function temporary() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'uapkg-catalog-test-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function record(product: ReleaseProduct = 'cli'): CatalogRecord {
  const version = product === 'cli' ? '1.6.0' : '0.2.0';
  return {
    entry: {
      schemaVersion: 1,
      product,
      version,
      publishedAt: '2026-11-01T12:34:56Z',
      tag: releaseTag(product, version),
      files: [...PLATFORMS],
    },
    checksums: Buffer.from(
      PLATFORMS.map((platform) => `${'0'.repeat(64)}  ${artifactName(product, version, platform)}\n`).join(''),
    ),
    signature: Buffer.from('already verified original signature'),
  };
}
function remote() {
  const directory = temporary();
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
          revision += 1;
          return true;
        },
      };
    },
  };
  return {
    directory,
    adapter,
    race(callback: () => void) {
      beforePush = callback;
    },
  };
}
describe('durable release catalog publication', () => {
  it('does not publish a historical six-target matrix as a new release', () => {
    const target = remote();
    const historical = record();
    historical.entry.files = [...HISTORICAL_PLATFORMS];
    expect(() => publishCatalog(historical, target.adapter)).toThrow('current release platform matrix');
    expect(existsSync(path.join(target.directory, 'cli/1.6.0'))).toBe(false);
  });
  it('publishes exact original metadata once and rejects replacement bytes', () => {
    const target = remote();
    const published = record();
    expect(publishCatalog(published, target.adapter)).toEqual({ changed: true, attempts: 1 });
    expect(publishCatalog(published, target.adapter)).toEqual({ changed: false, attempts: 1 });
    expect(readdirSync(path.join(target.directory, 'cli/1.6.0')).sort()).toEqual(
      ['entry.json', 'SHASUMS256.txt', 'SHASUMS256.txt.minisig'].sort(),
    );
    expect(readFileSync(path.join(target.directory, 'cli/1.6.0/SHASUMS256.txt.minisig'))).toEqual(published.signature);
    expect(() => publishCatalog({ ...published, signature: Buffer.from('different') }, target.adapter)).toThrow(
      'Immutable',
    );
    expect(() =>
      publishCatalog(
        { ...published, entry: { ...published.entry, publishedAt: '2026-11-02T12:34:56Z' } },
        target.adapter,
      ),
    ).toThrow('Immutable');
  });
  it('retries a concurrent CLI/launcher update without losing either record', () => {
    const target = remote();
    target.race(() => publishCatalog(record('launcher'), target.adapter));
    expect(publishCatalog(record('cli'), target.adapter)).toEqual({ changed: true, attempts: 2 });
    expect(existsSync(path.join(target.directory, 'cli/1.6.0/entry.json'))).toBe(true);
    expect(existsSync(path.join(target.directory, 'launcher/0.2.0/entry.json'))).toBe(true);
  });
  it('preserves independently managed status annotations during publication retries', () => {
    const target = remote();
    const published = record();
    publishCatalog(published, target.adapter);
    const file = path.join(target.directory, 'cli/1.6.0/entry.json');
    const annotated = {
      ...published.entry,
      yanked: { at: '2026-11-18T12:34:56Z', reason: 'Broken release' },
      quarantined: { at: '2026-11-18T13:00:00Z', reason: 'Security investigation' },
    };
    writeFileSync(file, `${JSON.stringify(annotated, null, 2)}\n`);
    const original = readFileSync(file);
    expect(publishCatalog(published, target.adapter)).toEqual({ changed: false, attempts: 1 });
    expect(readFileSync(file)).toEqual(original);
    expect(() =>
      publishCatalog(
        { ...published, checksums: Buffer.from(published.checksums.toString().replace(/^0/gm, '1')) },
        target.adapter,
      ),
    ).toThrow('Immutable');
    writeFileSync(file, JSON.stringify({ ...annotated, files: [...PLATFORMS].reverse() }));
    expect(() => publishCatalog(published, target.adapter)).toThrow('Immutable');
  });
  it('omits null status annotations from initial publication', () => {
    const target = remote();
    const published = record();
    publishCatalog({ ...published, entry: { ...published.entry, yanked: null, quarantined: null } }, target.adapter);
    expect(JSON.parse(readFileSync(path.join(target.directory, 'cli/1.6.0/entry.json'), 'utf8'))).toEqual(
      published.entry,
    );
  });
  it('rejects incomplete historical records and incomplete checksum sets', () => {
    const target = remote();
    mkdirSync(path.join(target.directory, 'cli/1.6.0'), { recursive: true });
    writeFileSync(path.join(target.directory, 'cli/1.6.0/entry.json'), '{}');
    expect(() => publishCatalog(record(), target.adapter)).toThrow('Immutable');
    expect(() => publishCatalog({ ...record(), checksums: Buffer.from('') }, target.adapter)).toThrow('Checksums');
  });
  it('bounds branch contention and allows a later manual retry', () => {
    const target = remote();
    const blocked: CatalogAdapter = {
      begin() {
        const attempt = target.adapter.begin();
        return { ...attempt, push: () => false };
      },
    };
    expect(() => publishCatalog(record(), blocked, 2)).toThrow('2 attempts');
    expect(publishCatalog(record(), target.adapter).changed).toBe(true);
  });
});
