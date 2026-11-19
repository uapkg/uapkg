import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INTERNAL_PROFILE_HOME_ENV } from '@uapkg/common';
import Log from '@uapkg/log';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { ConfigCommand, type ConfigCommandOptions } from '../../src/commands/ConfigCommand.ts';
import { DiagnosticReporter } from '../../src/reporting/DiagnosticReporter.ts';

const directories: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uapkg-launcher-config-command-'));
  directories.push(root);
  const profile = path.join(root, 'profile');
  const project = path.join(root, 'game');
  fs.mkdirSync(project);
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(project, 'uapkg.json'), JSON.stringify({ kind: 'project' }));
  const file = path.join(profile, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ term: { verbose: true } }));
  vi.stubEnv(INTERNAL_PROFILE_HOME_ENV, profile);
  const invoke = (options: Partial<ConfigCommandOptions>) =>
    new ConfigCommand({
      cwd: project,
      action: 'get',
      output: 'json',
      showOrigin: false,
      trace: false,
      ...options,
    }).execute();
  return { file, profile, project, invoke };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('launcher settings through the normal config command', () => {
  it('reports the default CLI selector without writing configuration', async () => {
    const { file, project, invoke } = fixture();
    const before = fs.readFileSync(file);
    const log = vi.spyOn(Log, 'info').mockImplementation(() => {});
    const pathToProperty = 'launcher.defaultCliVersion';

    expect(await invoke({ pathToProperty })).toBe(0);
    expect(log).toHaveBeenLastCalledWith('"latest"');
    expect(await invoke({ pathToProperty: 'launcher' })).toBe(0);
    expect(JSON.parse(log.mock.lastCall?.[0] ?? '')).toEqual({
      defaultCliVersion: 'latest',
      autoLauncherUpdate: true,
      autoCLIUpdate: true,
      autoUpdate: { minimumReleaseAge: '3d' },
    });

    expect(await invoke({ pathToProperty, trace: true })).toBe(0);
    expect(JSON.parse(log.mock.lastCall?.[0] ?? '')).toMatchObject([
      { source: 'default', value: 'latest' },
      { source: 'global', value: null },
      { source: 'local', value: null },
    ]);
    for (const scope of ['global', 'local'] as const) {
      expect(await invoke({ pathToProperty, scope })).toBe(0);
      expect(log).toHaveBeenLastCalledWith('null');
    }

    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(path.join(project, '.uapkg'))).toBe(false);
  });

  it('writes and reads global launcher settings through the shared config file', async () => {
    const { file, profile, invoke } = fixture();
    expect(
      await invoke({
        action: 'set',
        pathToProperty: 'launcher.defaultCliVersion',
        rawValue: '2.0.0-beta.1+build.2',
        scope: 'global',
      }),
    ).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      term: { verbose: true },
      launcher: { defaultCliVersion: '2.0.0-beta.1+build.2' },
    });
    const log = vi.spyOn(Log, 'info').mockImplementation(() => {});
    expect(await invoke({ pathToProperty: 'launcher.defaultCliVersion', scope: 'global' })).toBe(0);
    expect(log).toHaveBeenLastCalledWith('"2.0.0-beta.1+build.2"');
    expect(await invoke({ pathToProperty: 'launcher.defaultCliVersion' })).toBe(0);
    expect(log).toHaveBeenLastCalledWith('"2.0.0-beta.1+build.2"');
    expect(fs.existsSync(path.join(profile, 'launcher.json'))).toBe(false);
    expect(await invoke({ action: 'delete', pathToProperty: 'launcher.defaultCliVersion', scope: 'global' })).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      term: { verbose: true },
      launcher: {},
    });
    expect(await invoke({ pathToProperty: 'launcher.defaultCliVersion' })).toBe(0);
    expect(log).toHaveBeenLastCalledWith('"latest"');
  });

  it('retains normal local write scope unless --global is selected', async () => {
    const { file, project, invoke } = fixture();
    expect(await invoke({ action: 'set', pathToProperty: 'launcher.defaultCliVersion', rawValue: 'latest' })).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(project, '.uapkg', 'config.json'), 'utf8'))).toEqual({
      launcher: { defaultCliVersion: 'latest' },
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ term: { verbose: true } });
  });

  it.each(['launcher.autoUpdate.minimumReleaseAge', 'packages.resolution.minimumReleaseAge'])(
    'reads and writes %s as a string, including zero shorthand',
    async (pathToProperty) => {
      const { project, invoke } = fixture();
      const log = vi.spyOn(Log, 'info').mockImplementation(() => {});
      expect(await invoke({ pathToProperty })).toBe(0);
      expect(log).toHaveBeenLastCalledWith('"3d"');
      expect(await invoke({ action: 'set', pathToProperty, rawValue: '12h', scope: 'global' })).toBe(0);
      expect(await invoke({ pathToProperty, scope: 'global' })).toBe(0);
      expect(log).toHaveBeenLastCalledWith('"12h"');
      expect(await invoke({ action: 'set', pathToProperty, rawValue: '0' })).toBe(0);
      const localFile = path.join(project, '.uapkg', 'config.json');
      const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
      expect(pathToProperty.split('.').reduce((value, key) => value[key], local)).toBe('0');
      expect(await invoke({ pathToProperty })).toBe(0);
      expect(log).toHaveBeenLastCalledWith('"0"');
      expect(await invoke({ action: 'delete', pathToProperty, scope: 'local' })).toBe(0);
      expect(await invoke({ pathToProperty })).toBe(0);
      expect(log).toHaveBeenLastCalledWith('"12h"');
    },
  );

  it('reports ignored overflowing package age settings and retains the global origin', async () => {
    const { file, project, invoke } = fixture();
    const pathToProperty = 'packages.resolution.minimumReleaseAge';
    fs.writeFileSync(file, JSON.stringify({ packages: { resolution: { minimumReleaseAge: '7d' } } }));
    fs.mkdirSync(path.join(project, '.uapkg'));
    fs.writeFileSync(
      path.join(project, '.uapkg/config.json'),
      JSON.stringify({ packages: { resolution: { minimumReleaseAge: '9007199254741s' } } }),
    );
    const log = vi.spyOn(Log, 'info').mockImplementation(() => {});
    const report = vi.spyOn(DiagnosticReporter.prototype, 'reportAll').mockImplementation(() => {});
    expect(await invoke({ pathToProperty, showOrigin: true, output: 'text' })).toBe(0);
    expect(report).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warning',
          code: 'CONFIG_INVALID_VALUE',
          data: expect.objectContaining({ path: pathToProperty, source: 'local', ignored: true }),
        }),
      ]),
    );
    expect(await invoke({ pathToProperty, showOrigin: true })).toBe(0);
    expect(JSON.parse(log.mock.lastCall?.[0] ?? '')).toMatchObject({ value: '7d', source: 'global' });
    expect(await invoke({ pathToProperty, trace: true })).toBe(0);
    expect(JSON.parse(log.mock.lastCall?.[0] ?? '')).toMatchObject([
      { source: 'default', value: '3d', status: 'accepted' },
      { source: 'global', value: '7d', status: 'accepted' },
      { source: 'local', value: '9007199254741s', status: 'ignored' },
    ]);
    const before = fs.readFileSync(file);
    expect(await invoke({ action: 'set', pathToProperty, rawValue: '-1d', scope: 'global' })).toBe(1);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it.each(['autoLauncherUpdate', 'autoCLIUpdate'])(
    'layers launcher.%s with local writes and explicit global scope',
    async (key) => {
      const { file, project, invoke } = fixture();
      const pathToProperty = `launcher.${key}`;
      const log = vi.spyOn(Log, 'info').mockImplementation(() => {});
      expect(await invoke({ pathToProperty })).toBe(0);
      expect(log).toHaveBeenLastCalledWith('true');

      expect(await invoke({ action: 'set', pathToProperty, rawValue: 'false' })).toBe(0);
      const localFile = path.join(project, '.uapkg', 'config.json');
      expect(JSON.parse(fs.readFileSync(localFile, 'utf8'))).toEqual({
        launcher: { [key]: false },
      });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ term: { verbose: true } });
      expect(await invoke({ pathToProperty })).toBe(0);
      expect(log).toHaveBeenLastCalledWith('false');

      expect(await invoke({ action: 'set', pathToProperty, rawValue: 'true', scope: 'global' })).toBe(0);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).launcher).toEqual({ [key]: true });
      expect(await invoke({ pathToProperty })).toBe(0);
      expect(log).toHaveBeenLastCalledWith('false');
      expect(await invoke({ pathToProperty, scope: 'global' })).toBe(0);
      expect(log).toHaveBeenLastCalledWith('true');

      expect(await invoke({ action: 'set', pathToProperty, rawValue: 'true', scope: 'local' })).toBe(0);
      expect(await invoke({ action: 'delete', pathToProperty, scope: 'local' })).toBe(0);
      expect(await invoke({ pathToProperty })).toBe(0);
      expect(log).toHaveBeenLastCalledWith('true');
      expect(await invoke({ action: 'set', pathToProperty, rawValue: 'false', scope: 'global' })).toBe(0);
      expect(await invoke({ pathToProperty })).toBe(0);
      expect(log).toHaveBeenLastCalledWith('false');
      expect(await invoke({ action: 'delete', pathToProperty, scope: 'global' })).toBe(0);
      expect(await invoke({ pathToProperty })).toBe(0);
      expect(log).toHaveBeenLastCalledWith('true');
    },
  );

  it('reports the retained origin and ignored local override through CLI tracing', async () => {
    const { file, project, invoke } = fixture();
    fs.writeFileSync(file, JSON.stringify({ launcher: { defaultCliVersion: '1.2.3' } }));
    fs.mkdirSync(path.join(project, '.uapkg'));
    fs.writeFileSync(
      path.join(project, '.uapkg', 'config.json'),
      JSON.stringify({
        launcher: { defaultCliVersion: '^1.2.3', autoCLIUpdate: false },
      }),
    );
    const log = vi.spyOn(Log, 'info').mockImplementation(() => {});
    const pathToProperty = 'launcher.defaultCliVersion';
    expect(await invoke({ pathToProperty })).toBe(0);
    expect(log).toHaveBeenLastCalledWith('"1.2.3"');
    expect(await invoke({ pathToProperty, showOrigin: true })).toBe(0);
    expect(JSON.parse(log.mock.lastCall?.[0] ?? '')).toMatchObject({ value: '1.2.3', source: 'global' });
    expect(await invoke({ pathToProperty, trace: true })).toBe(0);
    expect(JSON.parse(log.mock.lastCall?.[0] ?? '')).toMatchObject([
      { source: 'default', value: 'latest', status: 'accepted' },
      { source: 'global', value: '1.2.3', status: 'accepted' },
      { source: 'local', value: '^1.2.3', status: 'ignored', reason: expect.stringContaining('expected') },
    ]);
    expect(await invoke({ pathToProperty: 'launcher.autoCLIUpdate' })).toBe(0);
    expect(log).toHaveBeenLastCalledWith('false');
  });

  it.each([
    ['launcher.cliSource', 'winget'],
    ['launcher.defaultCliVersion', 'nightly'],
    ['launcher.defaultCliVersion', '^1.2.3'],
  ])('rejects %s=%s without modifying global configuration', async (pathToProperty, rawValue) => {
    const { file, invoke } = fixture();
    const before = fs.readFileSync(file);
    expect(await invoke({ action: 'set', pathToProperty, rawValue, scope: 'global' })).toBe(1);
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
