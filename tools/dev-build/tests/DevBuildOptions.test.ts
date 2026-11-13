import { describe, expect, it } from 'vite-plus/test';
import { parseDevBuildOptions } from '../DevBuildOptions.ts';

describe('parseDevBuildOptions', () => {
  it('defaults a normal build to development', () => {
    expect(parseDevBuildOptions('build', [])).toEqual({
      force: false,
      buildMode: 'development',
    });
  });

  it.each([
    ['--development', 'development'],
    ['--production', 'production'],
  ] as const)('selects %s mode explicitly', (flag, buildMode) => {
    expect(parseDevBuildOptions('build', [flag])).toEqual({
      force: false,
      buildMode,
    });
  });

  it('accepts package-manager option separators', () => {
    expect(parseDevBuildOptions('build', ['--', '--production'])).toEqual({
      force: false,
      buildMode: 'production',
    });
    expect(parseDevBuildOptions('link', ['--', '--force'])).toEqual({
      force: true,
      buildMode: 'development',
    });
    expect(parseDevBuildOptions('watch', ['--'])).toEqual({
      force: false,
      buildMode: 'development',
    });
    expect(() => parseDevBuildOptions('build', ['--', '--staging'])).toThrow('Unsupported option for build: --staging');
  });

  it('rejects conflicting build modes', () => {
    expect(() => parseDevBuildOptions('build', ['--development', '--production'])).toThrow(
      '--development and --production cannot be used together',
    );
  });

  it.each(['link', 'watch'] as const)('rejects mode overrides for %s', (command) => {
    expect(() => parseDevBuildOptions(command, ['--production'])).toThrow(
      `Build mode flags are not supported by ${command}; ${command} always uses a development build`,
    );
  });

  it('allows explicit replacement during linking but never bypasses unlink ownership', () => {
    expect(parseDevBuildOptions('link', ['--force'])).toEqual({
      force: true,
      buildMode: 'development',
    });
    expect(() => parseDevBuildOptions('unlink', ['--force'])).toThrow('Unsupported option for unlink: --force');
  });

  it('rejects options that do not belong to the command', () => {
    expect(() => parseDevBuildOptions('build', ['--force'])).toThrow('Unsupported option for build: --force');
    expect(() => parseDevBuildOptions('watch', ['--force'])).toThrow('Unsupported option for watch: --force');
  });
});
