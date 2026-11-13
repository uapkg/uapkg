import { describe, expect, it } from 'vite-plus/test';
import { ManifestSchema } from '../src/index.ts';

const base = { name: 'example', version: '1.0.0' };

describe('project CLI version', () => {
  it.each(['1.2.3', '2.0.0-beta.1', '1.2.3+build.4'])('preserves the exact version %s', (uapkgVersion) => {
    expect(ManifestSchema.parse({ ...base, kind: 'project', uapkgVersion }).uapkgVersion).toBe(uapkgVersion);
  });

  it.each(['latest', '^1.2.3', '~1.2.3', '1.2', 'v1.2.3', '=1.2.3', '', ' 1.2.3 ', 123, null])(
    'rejects a non-exact version %s',
    (uapkgVersion) => {
      expect(ManifestSchema.safeParse({ ...base, kind: 'project', uapkgVersion }).success).toBe(false);
    },
  );

  it('allows unpinned projects and plugins', () => {
    for (const kind of ['project', 'plugin']) {
      expect(ManifestSchema.safeParse({ ...base, kind }).success).toBe(true);
    }
  });

  it('rejects a CLI pin in a dependency plugin without restricting its dependencies', () => {
    expect(ManifestSchema.safeParse({ ...base, kind: 'plugin', uapkgVersion: '1.2.3' }).success).toBe(false);
    expect(ManifestSchema.safeParse({ ...base, kind: 'plugin', dependencies: { shared: '^1.0.0' } }).success).toBe(
      true,
    );
  });
});
