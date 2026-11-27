import { describe, expect, it } from 'vite-plus/test';
import { UAPKGCommandLineFactory } from '../../src/cli/UAPKGCommandLine.ts';
import { UAPKGCommandLineParser } from '../../src/cli/parsing/UAPKGCommandLineParser.ts';

describe('package resolution command options', () => {
  it.each([
    ['permissions', 'approve'],
    ['permissions', 'revoke'],
    ['lifecycle', 'retry'],
  ])('preserves an omitted or explicit registry for %s %s', async (command, action) => {
    const parser = new UAPKGCommandLineParser();
    const args = ['node', 'uapkg', command, action, '@studio/tool', '--capability', 'postinstall'];
    await expect(parser.parse(args)).resolves.toMatchObject({ packageName: '@studio/tool', registry: undefined });
    for (const registry of ['default', 'studio']) {
      await expect(parser.parse([...args, '--registry', registry])).resolves.toMatchObject({ registry });
    }
  });

  it.each([
    ['install', []],
    ['add', ['example@^1.0.0']],
    ['update', ['example']],
    ['remove', ['example']],
  ] as const)('parses --ignore-release-age independently of --force for %s', async (command, args) => {
    const parsed = await new UAPKGCommandLineParser().parse([
      'node',
      'uapkg',
      command,
      ...args,
      '--ignore-release-age',
      '--json',
    ]);
    expect(parsed).toMatchObject({ command, ignoreReleaseAge: true, outputFormat: 'json' });
    if (command !== 'remove') expect(parsed).toHaveProperty('force', false);
  });

  it('preserves update targets and recursive intent', async () => {
    await expect(
      new UAPKGCommandLineParser().parse([
        'node',
        'uapkg',
        'update',
        'example@^2.0.0',
        'other',
        '--recursive',
        '--ignore-release-age',
        '--force',
      ]),
    ).resolves.toMatchObject({
      command: 'update',
      specs: ['example@^2.0.0', 'other'],
      recursive: true,
      ignoreReleaseAge: true,
      force: true,
    });
  });

  it('defaults to direct updates and age protection through the public factory', () => {
    const factory = new UAPKGCommandLineFactory(() => '/project');
    expect(factory.createInstall()).toMatchObject({ ignoreReleaseAge: false, frozen: false, force: false });
    expect(factory.createAdd('example')).toMatchObject({ ignoreReleaseAge: false });
    expect(factory.createUpdate()).toMatchObject({ recursive: false, ignoreReleaseAge: false, specs: [] });
    expect(factory.createRemove('example')).toMatchObject({ ignoreReleaseAge: false });
  });
});
