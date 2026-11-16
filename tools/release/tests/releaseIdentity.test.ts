import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { validateReleaseIdentity } from '../releaseIdentity.ts';
import { launcherVersionFromCargo } from '../NativeBuild.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const cliVersion = (
  JSON.parse(readFileSync(path.join(root, 'packages/uapkg/package.json'), 'utf8')) as { version: string }
).version;
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
  });
  it('requires distinct trust anchors before compiling a new launcher', () => {
    const version = launcherVersionFromCargo(root);
    vi.stubEnv('UAPKG_RELEASE_PUBLIC_KEY', 'artifact-public-key');
    vi.stubEnv('UAPKG_CATALOG_PUBLIC_KEY', 'artifact-public-key');
    expect(() => validateReleaseIdentity('launcher', version, '')).toThrow('distinct');
    vi.stubEnv('UAPKG_CATALOG_PUBLIC_KEY', 'metadata-public-key');
    expect(validateReleaseIdentity('launcher', version, '')).toBe(true);
  });
});
