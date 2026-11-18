import { describe, expect, it } from 'vite-plus/test';
import fs from 'node:fs';
import { parse } from 'semver';
import { z } from 'zod';
import { CliVersionSelectorSchema, PackageVersionSchema } from '../src/index.ts';

describe('CLI version selectors', () => {
  const fixtures = JSON.parse(
    fs.readFileSync(new URL('../../../launcher/crates/slim-config/fixtures/selectors.json', import.meta.url), 'utf8'),
  ) as { value: string; valid: boolean }[];

  it.each(fixtures)('preserves legacy selector acceptance for $value', ({ value, valid }) => {
    const schema = z.toJSONSchema(CliVersionSelectorSchema);
    expect(CliVersionSelectorSchema.safeParse(value).success).toBe(valid);
    expect(value.length <= (schema.maxLength as number) && new RegExp(schema.pattern as string).test(value)).toBe(
      valid,
    );
    expect(legacySelector(value)).toBe(valid);
  });
  it.each(['latest', '1.6.0', '2.0.0-alpha', '2.0.0-beta', '2.0.0-beta.10', '2.0.0-alpha.0+build.2'])(
    'accepts %s without rewriting it',
    (value) => expect(CliVersionSelectorSchema.parse(value)).toBe(value),
  );
  it.each([
    'v1.0.0',
    '^1.0.0',
    '1.0',
    '01.0.0',
    '1.0.0-alpha.01',
    '1.0.0-alpha+build',
    '1.0.0-rc.1',
    'nightly',
    'beta',
    '',
    ' latest ',
  ])('rejects unsupported selector %s', (value) =>
    expect(CliVersionSelectorSchema.safeParse(value).success).toBe(false),
  );
  it('does not broaden or restrict ordinary package versions', () => {
    expect(PackageVersionSchema.safeParse('latest').success).toBe(false);
    expect(PackageVersionSchema.safeParse('1.0.0-rc.1').success).toBe(true);
  });
});

// Keep the previous implementation as a compatibility oracle for the portable
// schema constraints, including npm semver's limits and canonical spelling.
function legacySelector(value: string): boolean {
  if (value === 'latest') return true;
  const parsed = parse(value);
  if (!parsed) return false;
  const build = parsed.build.length ? `+${parsed.build.join('.')}` : '';
  if (value !== `${parsed.version}${build}`) return false;
  if (!parsed.prerelease.length) return true;
  const preview = parsed.prerelease.join('.');
  return /^(alpha|beta)\.(0|[1-9]\d*)$/.test(preview) || (!build && /^(alpha|beta)$/.test(preview));
}
