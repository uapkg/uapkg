import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INTERNAL_PROFILE_HOME_ENV } from '@uapkg/common';
import Log from '@uapkg/log';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { ConfigCommand, type ConfigCommandOptions } from '../../src/commands/ConfigCommand.ts';

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
  it('writes and reads global launcher settings through the shared config file', async () => {
    const { file, profile, invoke } = fixture();
    expect(
      await invoke({ action: 'set', pathToProperty: 'launcher.cliSource', rawValue: 'npm', scope: 'global' }),
    ).toBe(0);
    expect(
      await invoke({
        action: 'set',
        pathToProperty: 'launcher.defaultCliVersion',
        rawValue: '2.0.0-rc.1+build.2',
        scope: 'global',
      }),
    ).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      term: { verbose: true },
      launcher: { cliSource: 'npm', defaultCliVersion: '2.0.0-rc.1+build.2' },
    });
    const log = vi.spyOn(Log, 'info').mockImplementation(() => {});
    expect(await invoke({ pathToProperty: 'launcher.cliSource', scope: 'global' })).toBe(0);
    expect(log).toHaveBeenLastCalledWith('"npm"');
    expect(fs.existsSync(path.join(profile, 'launcher.json'))).toBe(false);
    expect(await invoke({ action: 'delete', pathToProperty: 'launcher.defaultCliVersion', scope: 'global' })).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      term: { verbose: true },
      launcher: { cliSource: 'npm' },
    });
  });

  it('retains normal local write scope unless --global is selected', async () => {
    const { file, project, invoke } = fixture();
    expect(await invoke({ action: 'set', pathToProperty: 'launcher.cliSource', rawValue: 'npm' })).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(project, '.uapkg', 'config.json'), 'utf8'))).toEqual({
      launcher: { cliSource: 'npm' },
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ term: { verbose: true } });
  });

  it.each([
    ['launcher.cliSource', 'winget'],
    ['launcher.defaultCliVersion', 'latest'],
    ['launcher.defaultCliVersion', '^1.2.3'],
  ])('rejects %s=%s without modifying global configuration', async (pathToProperty, rawValue) => {
    const { file, invoke } = fixture();
    const before = fs.readFileSync(file);
    expect(await invoke({ action: 'set', pathToProperty, rawValue, scope: 'global' })).toBe(1);
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
