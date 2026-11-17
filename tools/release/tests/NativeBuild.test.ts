import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { runChecked } from '../../../packages/uapkg/build/EnginePackage.ts';
import { buildLauncherArtifact } from '../NativeBuild.ts';
import { runRelease } from '../runRelease.ts';

vi.mock('../../../packages/uapkg/build/EnginePackage.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../packages/uapkg/build/EnginePackage.ts')>()),
  runChecked: vi.fn(),
}));

const directories: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(compiledPlatform: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'uapkg-launcher-package-'));
  directories.push(root);
  const executable = path.join(root, 'compiled-launcher');
  writeFileSync(executable, 'already compiled binary');
  vi.mocked(runChecked).mockImplementation((_command, args) =>
    args.includes('--platform') ? `${compiledPlatform}\n` : '0.3.0\n',
  );
  return { executable, output: path.join(root, 'output') };
}

describe('compiled launcher packaging identity', () => {
  it('packages the compiled musl identity independently of the host Node platform', async () => {
    const { executable, output } = fixture('linux-x64-musl');
    const build = await buildLauncherArtifact(output, executable, 'x86_64-unknown-linux-musl');
    expect(build.artifacts[0]?.platform).toBe('linux-x64-musl');
    expect(build.artifacts[0]?.fileName).toBe('uapkg-launcher-0.3.0-linux-x64-musl.tar.gz');
    expect(existsSync(path.join(output, 'launcher/uapkg'))).toBe(true);
    expect(existsSync(path.join(output, 'launcher/uapkg.exe'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(output, 'build-linux-x64-musl.json'), 'utf8'))).toEqual(build);
  });

  it('rejects a glibc executable mislabeled with a musl target before writing artifacts', async () => {
    const { executable, output } = fixture('linux-x64');
    await expect(buildLauncherArtifact(output, executable, 'x86_64-unknown-linux-musl')).rejects.toThrow(
      'differs from',
    );
    expect(existsSync(output)).toBe(false);
  });

  it('requires an explicit supported compilation target', async () => {
    await expect(runRelease(['build-launcher', '--output', 'output', '--launcher', 'launcher'])).rejects.toThrow(
      'requires --target',
    );
    const { executable, output } = fixture('win-arm64');
    await expect(buildLauncherArtifact(output, executable, 'i686-pc-windows-msvc')).rejects.toThrow(
      'Unsupported launcher target',
    );
    expect(runChecked).not.toHaveBeenCalled();
  });
});
