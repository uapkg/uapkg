import { describe, expect, expectTypeOf, it } from 'vite-plus/test';
import { z } from 'zod';
import {
  AssetHashSchema,
  ConcurrencyCountSchema,
  DurationSecondsSchema,
  GitTreeSchema,
  InstallPathSchema,
  isScopedPackageName,
  OrgNameSchema,
  type PackageName,
  PackageNameSchema,
  PackageVersionSchema,
  RegistryIdentifierSchema,
  RegistryIdentifierShortSchema,
  RegistryNameSchema,
  RegistryURLSchema,
  type UnixTimestamp,
  UnixTimestampSchema,
  VersionRangeSchema,
} from '../src/index.ts';

describe('composable branded primitives', () => {
  it('converts every branded primitive to JSON Schema without transform nodes', () => {
    const schemas = [
      AssetHashSchema,
      ConcurrencyCountSchema,
      DurationSecondsSchema,
      GitTreeSchema,
      InstallPathSchema,
      OrgNameSchema,
      PackageNameSchema,
      PackageVersionSchema,
      RegistryIdentifierSchema,
      RegistryIdentifierShortSchema,
      RegistryNameSchema,
      RegistryURLSchema,
      UnixTimestampSchema,
      VersionRangeSchema,
    ];

    for (const schema of schemas) {
      expect(() => z.toJSONSchema(schema)).not.toThrow();
      expect(schema.type).not.toBe('pipe');
    }
  });

  it('preserves branded inferred output types', () => {
    expectTypeOf(PackageNameSchema.parse('tool')).toEqualTypeOf<PackageName>();
    expectTypeOf(UnixTimestampSchema.parse(1)).toEqualTypeOf<UnixTimestamp>();
  });

  it('emits non-empty JSON Schema constraints for versions and ranges', () => {
    expect(z.toJSONSchema(PackageVersionSchema)).toMatchObject({ type: 'string', minLength: 1 });
    expect(z.toJSONSchema(VersionRangeSchema)).toMatchObject({ type: 'string', minLength: 1 });
  });
});

describe('AssetHashSchema', () => {
  it('accepts exactly sha256 with 64 lowercase hex characters', () => {
    expect(AssetHashSchema.safeParse(`sha256:${'a'.repeat(64)}`).success).toBe(true);
  });

  it.each([
    ['other algorithm', `sha512:${'a'.repeat(128)}`],
    ['short digest', `sha256:${'a'.repeat(63)}`],
    ['long digest', `sha256:${'a'.repeat(65)}`],
    ['uppercase digest', `sha256:${'A'.repeat(64)}`],
    ['missing prefix', 'a'.repeat(64)],
    ['md5-like', `md5:${'a'.repeat(32)}`],
  ])('rejects %s', (_label, value) => {
    expect(AssetHashSchema.safeParse(value).success).toBe(false);
  });
});

describe('PackageNameSchema', () => {
  it.each(['my-package', 'a', 'pkg2', '@acme/tool', '@a1/b2-c3'])('accepts %s', (value) => {
    expect(PackageNameSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['uppercase', 'MyPackage'],
    ['leading hyphen', '-pkg'],
    ['bare scope', '@acme'],
    ['scope only slash', '@acme/'],
    ['double slash', '@acme/a/b'],
    ['missing scope name', '@/tool'],
    ['uppercase scope', '@Acme/tool'],
    ['spaces', 'my package'],
    ['too long', 'a'.repeat(215)],
  ])('rejects %s', (_label, value) => {
    expect(PackageNameSchema.safeParse(value).success).toBe(false);
  });

  it('classifies scoped names', () => {
    expect(isScopedPackageName('@acme/tool')).toBe(true);
    expect(isScopedPackageName('tool')).toBe(false);
  });
});

describe('PackageVersionSchema', () => {
  it.each(['1.2.3', '0.0.0', '1.2.3-beta.1', '1.2.3+build.7'])('accepts canonical semver %s', (value) => {
    expect(PackageVersionSchema.safeParse(value).success).toBe(true);
  });

  it.each(['', 'v1.2.3', '=1.2.3', '01.2.3', ' 1.2.3', '1.2.3 ', 'not-a-version'])(
    'rejects non-canonical semver %s',
    (value) => {
      expect(PackageVersionSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('VersionRangeSchema', () => {
  it.each(['*', '^1.2.3', '>=0.5.0 <1.0.0', '1.2.x'])('accepts semantic range %s', (value) => {
    expect(VersionRangeSchema.safeParse(value).success).toBe(true);
  });

  it.each(['', 'not-a-range'])('rejects invalid or empty range %s', (value) => {
    expect(VersionRangeSchema.safeParse(value).success).toBe(false);
  });
});
