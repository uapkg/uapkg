import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INTERNAL_PROFILE_HOME_ENV } from '@uapkg/common';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createConfig, isLeafConfigPath, parseConfigCliValue } from '../src/index.ts';
import { configSchema, getDefaultConfig, partialConfigSchema } from '../src/schema/configSchema.ts';

const directories: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uapkg-launcher-config-'));
  directories.push(root);
  const profile = path.join(root, 'profile');
  const project = path.join(root, 'game');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'uapkg.json'), JSON.stringify({ kind: 'project' }));
  vi.stubEnv(INTERNAL_PROFILE_HOME_ENV, profile);
  return { profile, project };
}

function write(file: string, values: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(values));
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('shared launcher configuration', () => {
  it('defaults to GitHub without inventing an exact CLI version or creating a profile', () => {
    const { profile, project } = fixture();
    const config = createConfig({ cwd: project });
    expect(config.get('launcher')).toEqual({ cliSource: 'github-releases' });
    expect(config.get('launcher.defaultCliVersion')).toBeNull();
    expect(config.getDiagnostics()).toEqual([]);
    expect(fs.existsSync(profile)).toBe(false);
  });

  it('preserves unrelated global values while setting either launcher field', () => {
    const { profile, project } = fixture();
    const file = path.join(profile, 'config.json');
    write(file, { term: { verbose: true }, launcher: { defaultCliVersion: '1.2.3' } });
    const config = createConfig({ cwd: project });
    const source = config.set('launcher.cliSource', 'npm', { scope: 'global' });
    expect(source.ok).toBe(true);
    if (!source.ok) throw new Error('Expected a valid global source write');
    expect(source.value.file).toBe(file);
    expect(source.value.values).toEqual({
      term: { verbose: true },
      launcher: { defaultCliVersion: '1.2.3', cliSource: 'npm' },
    });
    write(file, source.value.values);
    const version = config.set('launcher.defaultCliVersion', '2.0.0-rc.1+build.2', { scope: 'global' });
    expect(version.ok).toBe(true);
    if (!version.ok) throw new Error('Expected a valid global version write');
    expect(version.value.values).toEqual({
      term: { verbose: true },
      launcher: { defaultCliVersion: '2.0.0-rc.1+build.2', cliSource: 'npm' },
    });
  });

  it('keeps normal CLI layering while global reads expose the values used by the launcher', () => {
    const { profile, project } = fixture();
    write(path.join(profile, 'config.json'), { launcher: { cliSource: 'npm', defaultCliVersion: '1.2.3' } });
    write(path.join(project, '.uapkg', 'config.json'), {
      launcher: { cliSource: 'github-releases', defaultCliVersion: '3.0.0' },
    });
    const config = createConfig({ cwd: project });
    expect(config.get('launcher')).toEqual({ cliSource: 'github-releases', defaultCliVersion: '3.0.0' });
    expect(config.get('launcher', { scope: 'global' })).toEqual({ cliSource: 'npm', defaultCliVersion: '1.2.3' });
    expect(config.trace('launcher.cliSource').map(({ source }) => source)).toEqual(['default', 'global', 'local']);
  });

  it.each(['1.2.3', '2.0.0-rc.1', '1.2.3+build.2'])(
    'supports setting an initially absent optional version through CLI schema introspection: %s',
    (version) => {
      expect(isLeafConfigPath('launcher.defaultCliVersion')).toBe(true);
      expect(parseConfigCliValue('launcher.defaultCliVersion', version)).toEqual({
        ok: true,
        value: version,
        diagnostics: [],
      });
      expect(partialConfigSchema.parse({ launcher: { defaultCliVersion: version } })).toEqual({
        launcher: { defaultCliVersion: version },
      });
    },
  );

  it.each(['latest', '^1.2.3', 'v1.2.3', '1.2', '1.2.3-01', '', null, 123])(
    'rejects a non-exact configured CLI version: %s',
    (version) => {
      expect(partialConfigSchema.safeParse({ launcher: { defaultCliVersion: version } }).success).toBe(false);
      expect(
        configSchema.safeParse({ ...getDefaultConfig(), launcher: { cliSource: 'npm', defaultCliVersion: version } })
          .success,
      ).toBe(false);
    },
  );

  it.each(['github', 'latest', 'winget', '', null, 123])('rejects unsupported CLI sources: %s', (cliSource) => {
    expect(partialConfigSchema.safeParse({ launcher: { cliSource } }).success).toBe(false);
    expect(configSchema.safeParse({ ...getDefaultConfig(), launcher: { cliSource } }).success).toBe(false);
  });
});
