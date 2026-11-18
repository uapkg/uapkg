import { readFileSync } from 'node:fs';
import path from 'node:path';
import { compare } from 'semver';
import { describe, expect, it } from 'vite-plus/test';
import { verifyMinisign } from '../Minisign.ts';
import {
  artifactName,
  assertCurrentFiles,
  assertExactVersion,
  HISTORICAL_PLATFORMS,
  KNOWN_PLATFORMS,
  PLATFORMS,
  parseChecksums,
  serializeCatalogEntry,
  validateEntry,
  validateCurrentEntry,
  validateIndex,
  validateReplacements,
} from '../ReleaseContract.ts';

const directory = path.resolve(import.meta.dirname, '../fixtures');
const fixture = JSON.parse(readFileSync(path.join(directory, 'catalog-contract.json'), 'utf8'));
function verifies(file: string, key: string, mutate = false): boolean {
  const bytes = readFileSync(path.join(directory, file));
  if (mutate) bytes[0] = bytes[0]! ^ 1;
  try {
    verifyMinisign(
      bytes,
      readFileSync(path.join(directory, key), 'utf8'),
      readFileSync(path.join(directory, `${file}.minisig`), 'utf8'),
    );
    return true;
  } catch {
    return false;
  }
}
describe('shared release contract fixtures', () => {
  it('accepts historical dates and full publication timestamps without changing their precision', () => {
    const withDate = (date: unknown) => ({
      ...fixture.index,
      releases: fixture.index.releases.map((release: Record<string, unknown>) => ({ ...release, date })),
    });
    for (const date of [
      '2024-02-29',
      '2026-11-18T12:34:56Z',
      '2026-11-18T12:34:56.123456789Z',
      '2026-11-18T14:34:56.123+02:00',
      '2026-11-18T10:34:56-02:00',
    ])
      expect(validateIndex(withDate(date))).toEqual(withDate(date));
    for (const date of [
      undefined,
      null,
      0,
      '',
      '2026-02-29',
      '2026-02-30T00:00:00Z',
      '2026-11-18T24:00:00Z',
      '2026-11-18T12:60:00Z',
      '2026-11-18T12:00:60Z',
      '2026-11-18T12:00:00',
      '2026-11-18T12:00:00+24:00',
      '2026-11-18T12:00:00+00:60',
      '2026-11-18T12:00:00.1234567890Z',
      '2026-11-18\n',
      '2026-11-18T12:00:00Z\n',
    ])
      expect(() => validateIndex(withDate(date))).toThrow('release date');
  });
  it('uses canonical versions, reserved aliases and numeric SemVer ordering', () => {
    for (const version of fixture.validVersions) expect(() => assertExactVersion(version)).not.toThrow();
    for (const version of fixture.invalidVersions) expect(() => assertExactVersion(version)).toThrow();
    expect([...fixture.orderedVersions].reverse().sort(compare)).toEqual(fixture.orderedVersions);
    expect(artifactName('launcher', '0.2.0', 'win32-arm64')).toBe('uapkg-launcher-0.2.0-win32-arm64.tar.gz');
  });
  it('accepts the shared durable and public records; rejects malformed aliases and promotions', () => {
    expect(validateEntry(fixture.entry)).toEqual(fixture.entry);
    expect(validateIndex(fixture.index)).toEqual(fixture.index);
    expect(validateReplacements(fixture.replacements)).toEqual(fixture.replacements);
    for (const invalid of fixture.invalidIndexes) expect(() => validateIndex(invalid)).toThrow();
    for (const invalid of fixture.invalidReplacements) expect(() => validateReplacements(invalid)).toThrow();
    expect(() => validateEntry({ ...fixture.entry, publishedAt: '2026-11-01' })).toThrow('timestamp');
  });
  it('verifies exact Minisign bytes using distinct artifact and metadata trust anchors', () => {
    for (const file of ['index.json', 'replacements.json', 'moderated-cli.json', 'moderated-launcher.json']) {
      expect(verifies(file, 'metadata.pub')).toBe(true);
      expect(verifies(file, 'artifact.pub')).toBe(false);
      expect(verifies(file, 'metadata.pub', true)).toBe(false);
    }
    for (const file of ['moderated-cli.json', 'moderated-launcher.json'])
      expect(() => validateIndex(JSON.parse(readFileSync(path.join(directory, file), 'utf8')))).not.toThrow();
    expect(verifies('SHASUMS256.txt', 'artifact.pub')).toBe(true);
    expect(verifies('SHASUMS256.txt', 'metadata.pub')).toBe(false);
  });
  it('requires one checksum for each canonical archive and no additional paths', () => {
    const bytes = readFileSync(path.join(directory, 'SHASUMS256.txt'), 'utf8');
    expect(parseChecksums(bytes, 'cli', '2.0.0', fixture.entry.files).size).toBe(6);
    for (const invalid of [bytes + bytes, bytes.replace('uapkg-cli', '../uapkg-cli'), bytes.replace(/^.*\n/, '')])
      expect(() => parseChecksums(invalid, 'cli', '2.0.0', fixture.entry.files)).toThrow();
  });
  it('preserves historical receipts while requiring the current seven targets for publication', () => {
    expect(KNOWN_PLATFORMS).toHaveLength(9);
    const current = { ...fixture.entry, files: [...PLATFORMS] };
    expect(validateCurrentEntry(current)).toEqual(current);
    expect(validateEntry(fixture.entry).files).toEqual([...HISTORICAL_PLATFORMS]);
    expect(() => validateCurrentEntry(fixture.entry)).toThrow('current release platform matrix');
    for (const files of [
      PLATFORMS.slice(0, -1),
      [...PLATFORMS, PLATFORMS[0]],
      [...PLATFORMS, 'win32-x64'],
      PLATFORMS.map((platform) => (platform === 'win-x64' ? 'win32-x64' : platform)),
    ]) {
      expect(() => validateEntry({ ...current, files })).toThrow();
      expect(() => assertCurrentFiles(files)).toThrow();
    }
  });
  it('reads mixed historical/current indexes without rewriting signed Windows names', () => {
    const current = { version: '2.1.0', date: '2026-11-17', files: [...PLATFORMS] };
    const mixed = { ...fixture.index, aliases: { latest: '2.1.0' }, releases: [current, ...fixture.index.releases] };
    expect(validateIndex(mixed)).toEqual(mixed);
    expect(artifactName('cli', '2.1.0', 'win-x64')).toBe('uapkg-cli-2.1.0-win-x64.tar.gz');
    expect(artifactName('cli', '2.0.0', 'win32-x64')).toBe('uapkg-cli-2.0.0-win32-x64.tar.gz');
  });
  it('retains flagged receipts and requires quarantined public releases to have no files', () => {
    for (const entry of fixture.validStatusEntries) expect(validateEntry(entry)).toEqual(entry);
    for (const index of fixture.validStatusIndexes) expect(validateIndex(index)).toEqual(index);
    for (const entry of fixture.invalidStatusEntries) expect(() => validateEntry(entry)).toThrow();
    for (const index of fixture.invalidStatusIndexes) expect(() => validateIndex(index)).toThrow();
  });
  it('omits null status fields when serializing durable records', () => {
    expect(JSON.parse(serializeCatalogEntry({ ...fixture.entry, yanked: null, quarantined: null }))).toEqual(
      fixture.entry,
    );
    expect(JSON.parse(serializeCatalogEntry(fixture.validStatusEntries[2]))).toEqual(fixture.validStatusEntries[2]);
  });
});
