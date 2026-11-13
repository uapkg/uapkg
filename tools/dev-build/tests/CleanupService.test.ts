import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { CleanupService } from '../CleanupService.ts';
import { ProcessRunner } from '../ProcessRunner.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('CleanupService', () => {
  it('removes declared artifacts without deleting build source directories', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uapkg-cleanup-'));
    temporaryDirectories.push(workspaceRoot);

    const packageRoot = path.join(workspaceRoot, 'packages', 'uapkg');
    const packageBuildSource = path.join(packageRoot, 'build', 'CliBuild.ts');
    const rootBuildSource = path.join(workspaceRoot, 'build', 'orchestration.ts');
    const packageDist = path.join(packageRoot, 'dist');
    const packageCache = path.join(packageRoot, '.cache', 'retained.txt');
    const rootDist = path.join(workspaceRoot, 'dist', 'retained.txt');
    const rustTarget = path.join(workspaceRoot, 'launcher', 'target');
    const rustSource = path.join(workspaceRoot, 'launcher', 'src', 'main.rs');
    const generatedReleases = ['native', 'native-artifacts', 'release'].map((name) =>
      path.join(workspaceRoot, 'dist', name),
    );
    const packagedEngine = path.join(packageRoot, 'package');
    for (const directory of [...generatedReleases, packagedEngine]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'generated.txt'), 'generated');
    }
    fs.mkdirSync(rustTarget, { recursive: true });
    fs.mkdirSync(path.dirname(rustSource), { recursive: true });
    fs.writeFileSync(rustSource, 'fn main() {}');
    fs.mkdirSync(path.dirname(packageBuildSource), { recursive: true });
    fs.mkdirSync(path.dirname(rootBuildSource), { recursive: true });
    fs.mkdirSync(packageDist, { recursive: true });
    fs.mkdirSync(path.dirname(packageCache), { recursive: true });
    fs.mkdirSync(path.dirname(rootDist), { recursive: true });
    fs.writeFileSync(packageBuildSource, 'export {};\n', 'utf8');
    fs.writeFileSync(rootBuildSource, 'export {};\n', 'utf8');
    fs.writeFileSync(path.join(packageDist, 'index.js'), 'export {};\n', 'utf8');
    fs.writeFileSync(packageCache, 'retained\n', 'utf8');
    fs.writeFileSync(rootDist, 'retained\n', 'utf8');

    const runner = new ProcessRunner();
    const runAndCapture = vi.spyOn(runner, 'runAndCapture').mockReturnValue({
      stdout: '',
      stderr: '',
      status: 0,
    });

    new CleanupService(runner, workspaceRoot).cleanBuildArtifacts();

    expect(fs.existsSync(packageDist)).toBe(false);
    expect(fs.existsSync(rustTarget)).toBe(false);
    expect(fs.readFileSync(rustSource, 'utf8')).toBe('fn main() {}');
    for (const directory of [...generatedReleases, packagedEngine]) expect(fs.existsSync(directory)).toBe(false);
    expect(fs.readFileSync(packageBuildSource, 'utf8')).toBe('export {};\n');
    expect(fs.readFileSync(rootBuildSource, 'utf8')).toBe('export {};\n');
    expect(fs.readFileSync(packageCache, 'utf8')).toBe('retained\n');
    expect(fs.readFileSync(rootDist, 'utf8')).toBe('retained\n');
    expect(runAndCapture).toHaveBeenCalledWith('vp', ['cache', 'clean'], workspaceRoot, {
      ignoreFailure: true,
    });
  });

  it('preserves build source directories during a full clean', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uapkg-clean-all-'));
    temporaryDirectories.push(workspaceRoot);

    const packageRoot = path.join(workspaceRoot, 'packages', 'uapkg');
    const packageBuildSource = path.join(packageRoot, 'build', 'CliBuild.ts');
    const rootBuildSource = path.join(workspaceRoot, 'build', 'orchestration.ts');
    const packageDist = path.join(packageRoot, 'dist');
    fs.mkdirSync(path.dirname(packageBuildSource), { recursive: true });
    fs.mkdirSync(path.dirname(rootBuildSource), { recursive: true });
    fs.mkdirSync(packageDist, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, 'node_modules'), { recursive: true });
    fs.writeFileSync(packageBuildSource, 'export {};\n', 'utf8');
    fs.writeFileSync(rootBuildSource, 'export {};\n', 'utf8');
    fs.writeFileSync(path.join(packageDist, 'index.js'), 'export {};\n', 'utf8');

    const runner = new ProcessRunner();
    const runAndCapture = vi.spyOn(runner, 'runAndCapture').mockReturnValue({
      stdout: '',
      stderr: '',
      status: 0,
    });

    new CleanupService(runner, workspaceRoot).cleanAll();

    expect(fs.existsSync(packageDist)).toBe(false);
    expect(fs.existsSync(path.join(workspaceRoot, 'node_modules'))).toBe(false);
    expect(fs.readFileSync(packageBuildSource, 'utf8')).toBe('export {};\n');
    expect(fs.readFileSync(rootBuildSource, 'utf8')).toBe('export {};\n');
    expect(runAndCapture).toHaveBeenNthCalledWith(1, 'vp', ['cache', 'clean'], workspaceRoot, {
      ignoreFailure: true,
    });
    expect(runAndCapture).toHaveBeenNthCalledWith(2, 'vp', ['exec', 'pnpm', 'store', 'prune'], workspaceRoot, {
      ignoreFailure: true,
    });
  });
});
