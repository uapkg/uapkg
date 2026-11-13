import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import path from 'node:path';
import { BuildService } from '../BuildService.ts';
import { ProcessRunner } from '../ProcessRunner.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BuildService', () => {
  it.each(['development', 'production'] as const)('builds the monorepo with the %s configuration', (mode) => {
    const runner = new ProcessRunner();
    const run = vi.spyOn(runner, 'run').mockImplementation(() => undefined);
    const service = new BuildService(runner, 'D:/workspace');

    service.buildAll(mode);

    expect(run).toHaveBeenNthCalledWith(1, 'vp', ['run', '--cache', '-w', 'pack:libraries'], 'D:/workspace');
    expect(run).toHaveBeenNthCalledWith(
      2,
      'vp',
      ['run', '--cache', '-w', 'cli:build', '--', `--${mode}`],
      'D:/workspace',
    );
    expect(run).toHaveBeenNthCalledWith(
      3,
      'cargo',
      [
        'build',
        '--locked',
        '--target-dir',
        `target/${mode}`,
        ...(mode === 'development' ? ['--features', 'development'] : ['--release']),
      ],
      path.join('D:/workspace', 'launcher'),
    );
  });

  it('always builds the linked CLI with the development configuration', () => {
    const runner = new ProcessRunner();
    const run = vi.spyOn(runner, 'run').mockImplementation(() => undefined);
    const service = new BuildService(runner, 'D:/workspace');

    service.buildCliWithDependencies();

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith(
      'vp',
      ['run', '--cache', '-w', 'cli:build', '--', '--development'],
      'D:/workspace',
    );
  });

  it('rebuilds changed language inputs without globally linking packages', () => {
    const runner = new ProcessRunner();
    const run = vi.spyOn(runner, 'run').mockImplementation(() => undefined);
    const service = new BuildService(runner, 'D:/workspace');

    service.rebuildDevelopment(false, true);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      'cargo',
      ['build', '--locked', '--target-dir', 'target/development', '--features', 'development'],
      path.join('D:/workspace', 'launcher'),
    );
  });
});
