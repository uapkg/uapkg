import { describe, expect, it } from 'vite-plus/test';
import { CliVersionSelectorSchema, PackageVersionSchema } from '../src/index.ts';

describe('CLI version selectors', () => {
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
