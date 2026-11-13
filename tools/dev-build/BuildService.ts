import type { UAPKGBuildMode } from '@uapkg/common';
import path from 'node:path';
import type { ProcessRunner } from './ProcessRunner.ts';

export class BuildService {
  private readonly runner: ProcessRunner;
  private readonly workspaceRoot: string;

  constructor(runner: ProcessRunner, workspaceRoot: string) {
    this.runner = runner;
    this.workspaceRoot = workspaceRoot;
  }

  buildAll(mode: UAPKGBuildMode) {
    this.runner.run('vp', ['run', '--cache', '-w', 'pack:libraries'], this.workspaceRoot);
    this.runner.run('vp', ['run', '--cache', '-w', 'cli:build', '--', `--${mode}`], this.workspaceRoot);
    this.buildLauncher(mode);
  }

  buildCliWithDependencies() {
    this.runner.run('vp', ['run', '--cache', '-w', 'cli:build', '--', '--development'], this.workspaceRoot);
    this.buildLauncher('development');
  }

  buildLauncher(mode: UAPKGBuildMode) {
    const args = ['build', '--locked', '--target-dir', `target/${mode}`];
    if (mode === 'development') args.push('--features', 'development');
    else args.push('--release');
    this.runner.run('cargo', args, path.join(this.workspaceRoot, 'launcher'));
  }

  rebuildDevelopment(typescript: boolean, rust: boolean) {
    if (typescript)
      this.runner.run('vp', ['run', '--cache', '-w', 'cli:build', '--', '--development'], this.workspaceRoot);
    if (rust) this.buildLauncher('development');
  }

  launcherPath(mode: UAPKGBuildMode) {
    return path.join(
      this.workspaceRoot,
      'launcher',
      'target',
      mode,
      mode === 'development' ? 'debug' : 'release',
      process.platform === 'win32' ? 'uapkg.exe' : 'uapkg',
    );
  }
}
