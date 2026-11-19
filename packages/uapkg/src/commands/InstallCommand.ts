import type { Diagnostic } from '@uapkg/diagnostics';
import type { ManifestInstallOptions } from '@uapkg/package-manifest';
import type { CompositionRoot } from '#cli/app/CompositionRoot.ts';
import { InstallProgressReporter } from '#cli/reporting/InstallProgressReporter.ts';
import type { Command } from '#cli/commands/Command.ts';
import { PostinstallCandidateBuilder } from '#cli/commands/PostinstallCandidateBuilder.ts';
import { releaseAgeOverrideCommand, type PackageOperationName } from '#cli/commands/PackageOperation.ts';

export interface InstallCommandOptions {
  readonly force: boolean;
  readonly frozen: boolean;
  readonly dryRun: boolean;
  readonly outputFormat: 'text' | 'json';
  readonly ignoreReleaseAge?: boolean;
  readonly command?: PackageOperationName;
  readonly resolution?: ManifestInstallOptions;
  readonly diagnostics?: readonly Diagnostic[];
}

/**
 * `uapkg install` — resolve → plan → download/extract/remove → postinstall.
 *
 * Pipeline (never throws; errors become diagnostics):
 *
 *   1. Select package versions using the requested dependencies and the existing lockfile.
 *   2. Save changes to the manifest and lockfile once those versions are known.
 *   3. `Installer.execute(...)` → executes the install plan.
 *   4. Consume installer's status stream in parallel via `InstallProgressReporter`.
 *   5. On success (non-dryRun), `PostinstallOrchestrator.run()` for added/updated plugins.
 *   6. Report summary + diagnostics.
 *
 * `--force` and `--frozen` are mutually exclusive; the parser layer enforces this.
 */
export class InstallCommand implements Command {
  public constructor(
    private readonly root: CompositionRoot,
    private readonly options: InstallCommandOptions,
  ) {}

  public async execute(): Promise<number> {
    const pm = this.root.packageManifest;
    const commandDiagnostics: Diagnostic[] = [...(this.options.diagnostics ?? [])];
    const overrideCommand =
      this.options.resolution?.overrideCommand ??
      releaseAgeOverrideCommand(this.commandName, [
        ...(this.options.force ? ['--force'] : []),
        ...(this.options.frozen ? ['--frozen'] : []),
        ...(this.options.dryRun ? ['--dry-run'] : []),
        ...(this.options.outputFormat === 'json' ? ['--json'] : []),
      ]);
    const installResult = await pm.installWithReport({
      ...this.options.resolution,
      frozen: this.options.frozen,
      ignoreReleaseAge: this.options.ignoreReleaseAge === true,
      nowMs: this.options.resolution?.nowMs ?? Date.now(),
      overrideCommand,
    });
    if (!installResult.ok) return this.fail([...commandDiagnostics, ...installResult.diagnostics]);
    commandDiagnostics.push(...installResult.diagnostics);
    const { manifest, lockfile, previousLockfile, heldBack, minimumReleaseAge } = installResult.value;

    const progress = new InstallProgressReporter(
      this.options.outputFormat === 'json' ? { write() {}, writeLine() {} } : undefined,
    );

    // Trusted roots for verification-gated traversal: the manifest's declared buckets.
    const rootDependencies = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];

    const execution = this.root.installer.execute(lockfile, previousLockfile, {
      manifestRoot: this.root.cwd,
      force: this.options.force,
      dryRun: this.options.dryRun,
      rootDependencies,
    });
    const [executeResult] = await Promise.all([execution, progress.consume(this.root.installer.getStatusStream())]);

    if (!executeResult.ok) return this.fail([...commandDiagnostics, ...executeResult.diagnostics]);
    const report = executeResult.value;
    const plan = report.plan;
    const hasBranchFailures = report.failed.length > 0 || report.skipped.length > 0;

    const builder = new PostinstallCandidateBuilder();
    const candidates = builder.build(this.root, plan, lockfile, new Set(report.installed));
    const manifestType = builder.resolveManifestType(manifest);

    let postDiagnostics: readonly Diagnostic[] = [];
    if (!this.options.dryRun && candidates.length > 0) {
      const moduleNameOverride = manifest.kind === 'project' ? manifest.postinstall?.modules : undefined;
      const postResult = await this.root.postinstall.run({
        projectRoot: this.root.cwd,
        manifestType,
        candidates,
        moduleNameOverride,
      });
      postDiagnostics = postResult.diagnostics;
      if (!postResult.ok) {
        return this.fail([...commandDiagnostics, ...executeResult.diagnostics, ...postResult.diagnostics]);
      }
    }

    if (this.options.outputFormat === 'json') {
      this.root.json.emit({
        status: hasBranchFailures ? 'error' : 'ok',
        command: this.commandName,
        data: {
          plan: plan.summary,
          installed: report.installed,
          failed: report.failed,
          skipped: report.skipped,
          incompleteClosure: report.incompleteClosure,
          heldBack,
          ...(this.commandName === 'update' ? { heldBackCount: heldBack.length } : {}),
          minimumReleaseAge,
        },
        diagnostics: [...commandDiagnostics, ...executeResult.diagnostics, ...postDiagnostics],
      });
      return hasBranchFailures ? 1 : 0;
    }

    this.root.diagnostics.reportAll([...commandDiagnostics, ...executeResult.diagnostics, ...postDiagnostics]);
    progress.renderSummary(plan.summary);
    progress.renderHeldBack(heldBack, minimumReleaseAge, {
      showEmpty: this.commandName === 'update',
      // A successful bare add saves a caret range. Repeating it may no longer allow the held-back major version.
      retryCommand: this.options.resolution?.bareAdd ? undefined : overrideCommand,
    });
    return hasBranchFailures ? 1 : 0;
  }

  private fail(diagnostics: readonly Diagnostic[]): number {
    if (this.options.outputFormat === 'json') {
      this.root.json.emit({ status: 'error', command: this.commandName, diagnostics });
    } else {
      this.root.diagnostics.reportAll(diagnostics);
    }
    return 1;
  }

  private get commandName(): PackageOperationName {
    return this.options.command ?? 'install';
  }
}
