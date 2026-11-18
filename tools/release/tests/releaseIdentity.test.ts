import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { validateReleaseIdentity } from '../releaseIdentity.ts';
import { assertReleasePublicKeys } from '../checkPublicKeys.ts';
import { launcherVersionFromCargo } from '../NativeBuild.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const cliVersion = (
  JSON.parse(readFileSync(path.join(root, 'packages/uapkg/package.json'), 'utf8')) as { version: string }
).version;
const trusted = {
  artifact: readFileSync(path.join(root, 'docs/release-signing.pub'), 'utf8'),
  catalog: readFileSync(path.join(root, 'docs/release-catalog-signing.pub'), 'utf8'),
};
const encoded = (key: string) => key.trim().split(/\r?\n/).at(-1)!;
const otherKey = readFileSync(path.join(root, 'tools/release/fixtures/artifact.pub'), 'utf8');

beforeEach(() => {
  vi.stubEnv('UAPKG_RELEASE_PUBLIC_KEY', encoded(trusted.artifact));
  vi.stubEnv('UAPKG_CATALOG_PUBLIC_KEY', encoded(trusted.catalog));
});
afterEach(() => vi.unstubAllEnvs());

describe('manual release identity', () => {
  it('requires the committed version and an existing launcher selector for a new CLI build', () => {
    expect(validateReleaseIdentity('cli', cliVersion, '0.2.0')).toBe(true);
    expect(() => validateReleaseIdentity('cli', cliVersion, '')).toThrow('exact version');
    expect(() => validateReleaseIdentity('cli', '0.0.0', '0.2.0')).toThrow('committed version');
  });
  it('allows catalog-only retries after main has advanced, without selecting current npm publication', () => {
    expect(validateReleaseIdentity('cli', '0.0.0', '', true)).toBe(false);
    expect(validateReleaseIdentity('cli', cliVersion, '', true)).toBe(true);
    expect(validateReleaseIdentity('launcher', '0.0.0', '', true)).toBe(false);
    expect(validateReleaseIdentity('launcher', launcherVersionFromCargo(root), '', true)).toBe(true);
  });
  it('requires configured verification keys to match the anchors embedded in every new launcher', () => {
    const version = launcherVersionFromCargo(root);
    expect(validateReleaseIdentity('launcher', version, '')).toBe(true);
    vi.stubEnv('UAPKG_RELEASE_PUBLIC_KEY', otherKey);
    expect(() => validateReleaseIdentity('launcher', version, '')).toThrow('does not match docs/release-signing.pub');
  });
  it('checks verification keys for CLI releases and completed-release retries too', () => {
    vi.stubEnv('UAPKG_CATALOG_PUBLIC_KEY', otherKey);
    expect(() => validateReleaseIdentity('cli', cliVersion, '0.2.0')).toThrow(
      'does not match docs/release-catalog-signing.pub',
    );
    expect(() => validateReleaseIdentity('cli', '0.0.0', '', true)).toThrow(
      'does not match docs/release-catalog-signing.pub',
    );
    expect(() => validateReleaseIdentity('launcher', '0.0.0', '', true)).toThrow(
      'does not match docs/release-catalog-signing.pub',
    );
  });
});

describe('release verification anchors', () => {
  it('normalizes bare base64 and commented Minisign public files without comparing comments', () => {
    const configured = {
      artifact: `untrusted comment: local artifact label\r\n${encoded(trusted.artifact)}\r\n`,
      catalog: `\n ${encoded(trusted.catalog)} \n`,
    };
    expect(() => assertReleasePublicKeys(configured, trusted)).not.toThrow();
  });
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['invalid base64', 'not-a-key'],
    ['invalid length', 'AA=='],
    ['multiple keys', `${encoded(trusted.artifact)}\n${encoded(trusted.artifact)}`],
  ])('rejects a %s configured key', (_name, artifact) => {
    expect(() => assertReleasePublicKeys({ artifact, catalog: trusted.catalog }, trusted)).toThrow(
      'UAPKG_RELEASE_PUBLIC_KEY must contain a valid Minisign public key',
    );
  });
  it('rejects a malformed key algorithm in configuration or a tracked anchor', () => {
    const packet = Buffer.from(encoded(trusted.artifact), 'base64');
    packet.write('XX', 0);
    const malformed = packet.toString('base64');
    expect(() => assertReleasePublicKeys({ ...trusted, catalog: malformed }, trusted)).toThrow(
      'UAPKG_CATALOG_PUBLIC_KEY must contain a valid Minisign public key',
    );
    expect(() => assertReleasePublicKeys(trusted, { ...trusted, artifact: malformed })).toThrow(
      'docs/release-signing.pub must contain a valid Minisign public key',
    );
  });
  it('rejects a different valid artifact or catalog key', () => {
    expect(() => assertReleasePublicKeys({ ...trusted, artifact: otherKey }, trusted)).toThrow(
      'does not match docs/release-signing.pub',
    );
    expect(() => assertReleasePublicKeys({ ...trusted, catalog: otherKey }, trusted)).toThrow(
      'does not match docs/release-catalog-signing.pub',
    );
  });
  it('requires independent Ed25519 anchors even when key identifiers differ', () => {
    const packet = Buffer.from(encoded(trusted.artifact), 'base64');
    packet[2] = packet[2]! ^ 1;
    const shared = { artifact: trusted.artifact, catalog: packet.toString('base64') };
    expect(() => assertReleasePublicKeys(shared, trusted)).toThrow('distinct Ed25519 trust anchors');
    expect(() => assertReleasePublicKeys(trusted, shared)).toThrow('distinct Ed25519 trust anchors');
    expect(() => assertReleasePublicKeys({ ...trusted, catalog: trusted.artifact }, trusted)).toThrow(
      'distinct Ed25519 trust anchors',
    );
  });
});
