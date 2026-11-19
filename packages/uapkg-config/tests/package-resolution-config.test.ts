import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INTERNAL_PROFILE_HOME_ENV } from '@uapkg/common';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createConfig, isLeafConfigPath, parseConfigCliValue } from '../src/index.ts';
import { partialConfigSchema } from '../src/schema/configSchema.ts';

const directories: string[] = [];
const property = 'packages.resolution.minimumReleaseAge';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uapkg-package-resolution-config-'));
  directories.push(root);
  const profile = path.join(root, 'profile');
  const project = path.join(root, 'project');
  const cwd = path.join(project, 'nested');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(project, 'uapkg.json'), JSON.stringify({ kind: 'project' }));
  vi.stubEnv(INTERNAL_PROFILE_HOME_ENV, profile);
  return { profile, project, cwd };
}

function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('package resolution minimum release age configuration', () => {
  it('defaults to three days without creating profile files', () => {
    const { profile, cwd } = fixture();
    const config = createConfig({ cwd });
    expect(config.get('packages')).toEqual({ resolution: { minimumReleaseAge: '3d' } });
    expect(config.getWithOrigin(property)).toMatchObject({ value: '3d', source: 'default' });
    expect(config.getDiagnostics()).toEqual([]);
    expect(fs.existsSync(profile)).toBe(false);
  });

  it.each(['0', '0s', '15m', '1w2d3h4m5s', '10000000w'])(
    'supports compact duration values through schema introspection: %s',
    (value) => {
      expect(isLeafConfigPath(property)).toBe(true);
      expect(isLeafConfigPath('packages.resolution')).toBe(false);
      expect(parseConfigCliValue(property, value)).toEqual({ ok: true, value, diagnostics: [] });
      expect(partialConfigSchema.parse({ packages: { resolution: { minimumReleaseAge: value } } })).toEqual({
        packages: { resolution: { minimumReleaseAge: value } },
      });
    },
  );

  it.each(['-1d', '1m2h', '9007199254741s', `${'9'.repeat(63)}w`, 0, null])(
    'ignores invalid local values and retains the last valid layered value: %j',
    (invalid) => {
      const { profile, project, cwd } = fixture();
      write(path.join(profile, 'config.json'), { packages: { resolution: { minimumReleaseAge: '7d' } } });
      write(path.join(project, '.uapkg/config.json'), { packages: { resolution: { minimumReleaseAge: '12h' } } });
      write(path.join(cwd, '.uapkg/config.json'), {
        packages: { resolution: { minimumReleaseAge: invalid } },
        term: { verbose: true },
      });
      const config = createConfig({ cwd });
      expect(config.get(property)).toBe('12h');
      expect(config.get('term.verbose')).toBe(true);
      expect(config.getWithOrigin(property)).toMatchObject({ source: 'intermediary', value: '12h' });
      expect(config.getWithOrigin('packages')).toMatchObject({
        source: 'intermediary',
        value: { resolution: { minimumReleaseAge: '12h' } },
      });
      expect(config.trace(property).at(-1)).toMatchObject({
        status: 'ignored',
        reason: expect.stringContaining('retaining "12h"'),
      });
      expect(config.getDiagnostics()).toMatchObject([
        {
          level: 'warning',
          code: 'CONFIG_INVALID_VALUE',
          data: { path: property, source: 'local', ignored: true },
        },
      ]);
      if (invalid === '9007199254741s' || invalid === `${'9'.repeat(63)}w`) {
        expect(config.getDiagnostics()[0]?.message).toContain('safe integer in milliseconds');
      }
    },
  );

  it('accepts a local zero override and preserves raw scoped reads', () => {
    const { profile, cwd } = fixture();
    write(path.join(profile, 'config.json'), { packages: { resolution: { minimumReleaseAge: '7d' } } });
    write(path.join(cwd, '.uapkg/config.json'), { packages: { resolution: { minimumReleaseAge: '0' } } });
    const config = createConfig({ cwd });
    expect(config.get(property)).toBe('0');
    expect(config.getWithOrigin(property)).toMatchObject({ value: '0', source: 'local' });
    expect(config.get(property, { scope: 'global' })).toBe('7d');
  });

  it.each([
    ['packages', { packages: false }],
    ['packages.resolution', { packages: { resolution: false } }],
  ])('ignores invalid %s containers and traces their ignored descendants', (invalidPath, values) => {
    const { profile, cwd } = fixture();
    write(path.join(profile, 'config.json'), { packages: { resolution: { minimumReleaseAge: '7d' } } });
    write(path.join(cwd, '.uapkg/config.json'), values);
    const config = createConfig({ cwd });
    expect(config.get(property)).toBe('7d');
    expect(config.trace(property).at(-1)).toMatchObject({ status: 'ignored' });
    expect(config.getDiagnostics()).toMatchObject([{ data: { path: invalidPath, ignored: true } }]);
  });

  it('rejects invalid config writes without modifying files', () => {
    const { profile, cwd } = fixture();
    const file = path.join(profile, 'config.json');
    write(file, { packages: { resolution: { minimumReleaseAge: '7d' } } });
    const before = fs.readFileSync(file);
    const config = createConfig({ cwd });
    expect(config.set(property, '9007199254741s', { scope: 'global' }).ok).toBe(false);
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
