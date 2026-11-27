import type { Diagnostic } from '@uapkg/diagnostics';
import type { ManifestInstallOptions } from '@uapkg/package-manifest';
import type { CompositionRoot } from '#cli/app/CompositionRoot.ts';
import { InstallProgressReporter } from '#cli/reporting/InstallProgressReporter.ts';
import type { Command } from '#cli/commands/Command.ts';
import type { RetryTarget } from '@uapkg/lifecycle';
import { releaseAgeOverrideCommand, type PackageOperationName } from '#cli/commands/PackageOperation.ts';

export interface InstallCommandOptions {
  readonly ignoreScripts?: boolean;
  readonly force: boolean;
  readonly frozen: boolean;
  readonly dryRun: boolean;
  readonly outputFormat: 'text' | 'json';
  readonly ignoreReleaseAge?: boolean;
  readonly retry?: RetryTarget;
  readonly command?: PackageOperationName;
  readonly resolution?: ManifestInstallOptions;
  readonly diagnostics?: readonly Diagnostic[];
}

/** Materialize the resolved graph, execute granted hooks, and reconcile the active workspace. */
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

    const postDiagnostics = this.options.dryRun
      ? []
      : await this.root.lifecycle.install({
          report,
          manifest,
          frozen: this.options.frozen,
          ignoreScripts: this.options.ignoreScripts === true,
          refresh: this.commandName === 'update',
          retry: this.options.retry,
          invocation: this.root.invocation ?? [this.commandName],
        });
    const hasFailures = hasBranchFailures || postDiagnostics.some((d) => d.level === 'error');

    if (this.options.outputFormat === 'json') {
      this.root.json.emit({
        status: hasFailures ? 'error' : 'ok',
        command: this.commandName,
        data: {
          plan: plan.summary,
          installed: report.installed,
          failed: report.failed,
          skipped: report.skipped,
          incompleteClosure: report.incompleteClosure,
          deferredRemovals: report.deferredRemovals,
          heldBack,
          ...(this.commandName === 'update' ? { heldBackCount: heldBack.length } : {}),
          minimumReleaseAge,
        },
        diagnostics: [...commandDiagnostics, ...executeResult.diagnostics, ...postDiagnostics],
      });
      return hasFailures ? 1 : 0;
    }

    this.root.diagnostics.reportAll([...commandDiagnostics, ...executeResult.diagnostics, ...postDiagnostics]);
    progress.renderSummary(
      plan.summary,
      this.options.dryRun || hasBranchFailures || report.incompleteClosure.length > 0,
    );
    progress.renderHeldBack(heldBack, minimumReleaseAge, {
      showEmpty: this.commandName === 'update',
      // A successful bare add saves a caret range. Repeating it may no longer allow the held-back major version.
      retryCommand: this.options.resolution?.bareAdd ? undefined : overrideCommand,
    });
    return hasFailures ? 1 : 0;
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
