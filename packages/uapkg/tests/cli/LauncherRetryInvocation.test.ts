import { afterEach, expect, it, vi } from 'vite-plus/test';
import { UAPKGApplication } from '../../src/app/UAPKGApplication.ts';
import { launcherRetryInvocation } from '../../src/cli/launcherRetryInvocation.ts';
import { runUAPKGCLI } from '../../src/cli/runUAPKGCLI.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('parses delegated add flags and gives reporting the original ordered launcher invocation', async () => {
  vi.stubEnv('UAPKG_LAUNCHER_EXECUTABLE', 'fixture-launcher');
  vi.stubEnv(
    'UAPKG_INTERNAL_RETRY_FLAGS',
    JSON.stringify([
      [0, ['--offline']],
      [2, ['--cli-version=1.2.3']],
    ]),
  );
  const run = vi.spyOn(UAPKGApplication.prototype, 'run').mockResolvedValue(0);
  await runUAPKGCLI(['node', 'engine', 'add', 'mesh', '--json']);
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: 'add', source: 'mesh', outputFormat: 'json' }), [
    '--offline',
    'add',
    'mesh',
    '--cli-version=1.2.3',
    '--json',
  ]);
  expect(process.env.UAPKG_INTERNAL_RETRY_FLAGS).toBeUndefined();
});

it('keeps direct engine invocations unchanged, including offline mode from the environment', async () => {
  vi.stubEnv('UAPKG_LAUNCHER_EXECUTABLE', undefined);
  vi.stubEnv('UAPKG_CLI_VERSION', '1.2.3');
  vi.stubEnv('UAPKG_OFFLINE', '1');
  vi.stubEnv('UAPKG_INTERNAL_RETRY_FLAGS', JSON.stringify([[0, ['--offline']]]));
  const run = vi.spyOn(UAPKGApplication.prototype, 'run').mockResolvedValue(0);
  await runUAPKGCLI(['node', 'engine', 'install', '--frozen']);
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: 'install' }), ['install', '--frozen']);
});

it('preserves split selectors and literal arguments and ignores unrelated or malformed metadata', () => {
  const argv = ['install', '--', '--cli-version', 'literal'];
  expect(
    launcherRetryInvocation(
      argv,
      JSON.stringify([
        [1, ['--cli-version', 'latest']],
        [1, ['--offline']],
      ]),
    ),
  ).toEqual(['install', '--cli-version', 'latest', '--offline', '--', '--cli-version', 'literal']);
  for (const value of [
    [[0, ['--token', 'sensitive']]],
    [[0, ['--cli-version', 'unrelated input']]],
    [[0, ['--cli-version=latest\nprivate']]],
    [[2, ['--offline']]],
    [
      [1, ['--offline']],
      [0, ['--offline']],
    ],
  ])
    expect(launcherRetryInvocation(argv, JSON.stringify(value))).toEqual(argv);
});
