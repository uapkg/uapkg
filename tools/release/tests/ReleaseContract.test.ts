import { readFileSync } from 'node:fs';
import path from 'node:path';
import { compare } from 'semver';
import { describe, expect, it } from 'vite-plus/test';
import { verifyMinisign } from '../Minisign.ts';
import {
  artifactName,
  assertExactVersion,
  parseChecksums,
  validateEntry,
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
    for (const file of ['index.json', 'replacements.json']) {
      expect(verifies(file, 'metadata.pub')).toBe(true);
      expect(verifies(file, 'artifact.pub')).toBe(false);
      expect(verifies(file, 'metadata.pub', true)).toBe(false);
    }
    expect(verifies('SHASUMS256.txt', 'artifact.pub')).toBe(true);
    expect(verifies('SHASUMS256.txt', 'metadata.pub')).toBe(false);
  });
  it('requires one checksum for each canonical archive and no additional paths', () => {
    const bytes = readFileSync(path.join(directory, 'SHASUMS256.txt'), 'utf8');
    expect(parseChecksums(bytes, 'cli', '2.0.0', fixture.entry.files).size).toBe(6);
    for (const invalid of [bytes + bytes, bytes.replace('uapkg-cli', '../uapkg-cli'), bytes.replace(/^.*\n/, '')])
      expect(() => parseChecksums(invalid, 'cli', '2.0.0', fixture.entry.files)).toThrow();
  });
});
