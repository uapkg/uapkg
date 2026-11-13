import type { UAPKGBuildMode } from '@uapkg/common';
import { BuildService } from './BuildService.ts';
import { CleanupService } from './CleanupService.ts';
import { DevBuildStatusPrinter } from './DevBuildStatusPrinter.ts';
import { watchDevelopmentSources } from './DevBuildWatcher.ts';
import { NativeDevInstallation } from './NativeDevInstallation.ts';
import { ProcessRunner } from './ProcessRunner.ts';

export class DevBuildOrchestrator {
  private readonly buildService: BuildService;
  private readonly installation: NativeDevInstallation;
  private readonly statusPrinter: DevBuildStatusPrinter;
  private readonly cleanupService: CleanupService;
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    const runner = new ProcessRunner();
    this.buildService = new BuildService(runner, this.workspaceRoot);
    this.cleanupService = new CleanupService(runner, this.workspaceRoot);

    this.installation = new NativeDevInstallation(this.workspaceRoot);
    this.statusPrinter = new DevBuildStatusPrinter();
  }

  buildAll(mode: UAPKGBuildMode) {
    this.buildService.buildAll(mode);
  }

  link(options: { force: boolean }) {
    this.buildService.buildCliWithDependencies();
    this.reportPathChange(this.installation.link(this.buildService.launcherPath('development'), options.force));
    this.status();
  }

  async watch() {
    this.link({ force: false });
    await watchDevelopmentSources(this.workspaceRoot, async ({ typescript, rust }) => {
      this.buildService.rebuildDevelopment(typescript, rust);
      this.reportPathChange(this.installation.link(this.buildService.launcherPath('development')));
      console.log('[dev-build] Development launcher and engine are ready.');
    });
  }

  unlink() {
    this.reportPathChange(this.installation.unlink());
    this.status();
  }

  status() {
    this.statusPrinter.printStatus(this.installation.status());
  }

  clean() {
    this.cleanupService.cleanBuildArtifacts();
  }

  cleanAll() {
    this.reportPathChange(this.installation.unlink());
    this.cleanupService.cleanAll();
  }

  private reportPathChange(changed: boolean) {
    if (changed) console.log('[dev-build] User PATH updated. Open a new terminal to use the updated PATH.');
  }
}
