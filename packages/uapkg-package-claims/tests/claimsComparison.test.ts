import { PackageNameSchema, PackageVersionSchema } from '@uapkg/common-schema';
import { RegistryVersionSchema } from '@uapkg/registry-schema';
import { describe, expect, it } from 'vite-plus/test';
import { claimsFromRegistryVersion, compareClaims, normalizePackageClaims, type PackageClaims } from '../src/index.ts';

const NAME = PackageNameSchema.parse('my-plugin');
const VERSION = PackageVersionSchema.parse('1.2.3');

function packagedClaims(overrides: Partial<Record<string, unknown>> = {}): PackageClaims {
  const result = normalizePackageClaims({
    name: 'my-plugin',
    version: '1.2.3',
    kind: 'plugin',
    dependencies: { foo: '^1.0.0' },
    ...overrides,
  });
  if (!result.ok) throw new Error('fixture claims invalid');
  return result.value;
}

function registryEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return RegistryVersionSchema.parse({
    meta: { publishedAt: 1_700_000_000 },
    gitTree: 'a'.repeat(40),
    releaseFiles: {
      package: {
        url: 'https://example.com/releases/package.tgz',
        integrity: { hash: `sha256:${'b'.repeat(64)}`, size: 1234 },
      },
    },
    dependencies: { foo: '^1.0.0' },
    ...overrides,
  });
}

describe('compareClaims', () => {
  it('matches identical mandatory cores', () => {
    const packaged = packagedClaims();
    const registry = claimsFromRegistryVersion(NAME, VERSION, registryEntry());
    const result = compareClaims(packaged, registry);
    expect(result.equal).toBe(true);
    expect(result.packagedHash).toBe(result.registryHash);
    expect(result.differences).toEqual([]);
  });

  it('treats empty and omitted dependency buckets identically', () => {
    const packaged = packagedClaims({ devDependencies: {} });
    const registry = claimsFromRegistryVersion(NAME, VERSION, registryEntry());
    expect(compareClaims(packaged, registry).equal).toBe(true);
  });

  it('fails when the registry omits a packaged dependency', () => {
    const packaged = packagedClaims({ dependencies: { foo: '^1.0.0', hidden: '^9.0.0' } });
    const registry = claimsFromRegistryVersion(NAME, VERSION, registryEntry());
    const result = compareClaims(packaged, registry);
    expect(result.equal).toBe(false);
    expect(result.differences.map((difference) => difference.key)).toContain('dependencies');
  });

  it('fails when the registry declares an extra dependency', () => {
    const packaged = packagedClaims();
    const registry = claimsFromRegistryVersion(
      NAME,
      VERSION,
      registryEntry({ dependencies: { foo: '^1.0.0', injected: '^1.0.0' } }),
    );
    expect(compareClaims(packaged, registry).equal).toBe(false);
  });

  it('fails when private disagrees', () => {
    const packaged = packagedClaims({ private: true });
    const registry = claimsFromRegistryVersion(NAME, VERSION, registryEntry());
    const result = compareClaims(packaged, registry);
    expect(result.equal).toBe(false);
    expect(result.differences.map((difference) => difference.key)).toContain('private');
  });

  it('reads records without a private field as false', () => {
    const registry = claimsFromRegistryVersion(NAME, VERSION, registryEntry());
    expect(registry.private).toBe(false);
    expect(compareClaims(packagedClaims(), registry).equal).toBe(true);
  });

  it('compares explicit external registry aliases', () => {
    const packaged = packagedClaims({
      dependencies: { foo: { version: '^1.0.0', registry: 'internal' } },
    });
    const matching = claimsFromRegistryVersion(
      NAME,
      VERSION,
      registryEntry({ dependencies: { foo: { version: '^1.0.0', registry: 'internal' } } }),
    );
    const inherited = claimsFromRegistryVersion(NAME, VERSION, registryEntry());
    expect(compareClaims(packaged, matching).equal).toBe(true);
    expect(compareClaims(packaged, inherited).equal).toBe(false);
  });

  it('ignores unknown members of the registry record', () => {
    const registry = claimsFromRegistryVersion(NAME, VERSION, registryEntry({ futureOptional: 'anything' }));
    expect(compareClaims(packagedClaims(), registry).equal).toBe(true);
  });

  it('fails on identity mismatch', () => {
    const packaged = packagedClaims({ version: '9.9.9' });
    const registry = claimsFromRegistryVersion(NAME, VERSION, registryEntry());
    const result = compareClaims(packaged, registry);
    expect(result.equal).toBe(false);
    expect(result.differences.map((difference) => difference.key)).toContain('version');
  });
});
