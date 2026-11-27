import type { CompositionRoot } from '#cli/app/CompositionRoot.ts';
import { createDependencyNotFoundDiagnostic } from '@uapkg/diagnostics';
import { DependencyMutator } from '@uapkg/package-manifest';
import type { Command } from '#cli/commands/Command.ts';
import { InstallCommand } from '#cli/commands/InstallCommand.ts';
import { releaseAgeOverrideCommand } from '#cli/commands/PackageOperation.ts';

export interface RemoveCommandOptions {
  readonly ignoreScripts?: boolean;
  readonly packageName: string;
  readonly outputFormat: 'text' | 'json';
  readonly dryRun?: boolean;
  readonly ignoreReleaseAge?: boolean;
}

// ---------------------------------------------------------------------------
// RemoveCommand — removes a dependency from every bucket in the manifest and
// then immediately re-runs `InstallCommand` so on-disk state is reconciled.
//
// The installer's plan diff is what actually deletes the installed plugin —
// RemoveCommand's job is (1) mutate the manifest, (2) trigger the install.
// ---------------------------------------------------------------------------
export class RemoveCommand implements Command {
  public constructor(
    private readonly root: CompositionRoot,
    private readonly options: RemoveCommandOptions,
  ) {}

  public async execute(): Promise<number> {
    const nowMs = Date.now();
    const result = await this.root.packageManifest.readManifest();

    if (!result.ok) {
      if (this.options.outputFormat === 'json') {
        this.root.json.emit({ status: 'error', command: 'remove', diagnostics: result.diagnostics });
      } else {
        this.root.diagnostics.reportAll(result.diagnostics);
      }
      return 1;
    }

    const staged = new DependencyMutator().removeDependency(result.value, this.options.packageName);
    const diagnostics = [
      ...result.diagnostics,
      ...(!staged.removed ? [createDependencyNotFoundDiagnostic(this.options.packageName)] : []),
    ];

    if (!staged.removed) {
      if (this.options.outputFormat === 'text') this.root.diagnostics.reportAll(diagnostics);
      if (this.options.outputFormat === 'json') {
        this.root.json.emit({
          status: 'ok',
          command: 'remove',
          data: { removed: false, packageName: this.options.packageName },
          diagnostics,
        });
      }
      return 0;
    }

    // Reconcile on-disk state by delegating to the installer pipeline.
    const install = new InstallCommand(this.root, {
      ignoreScripts: this.options.ignoreScripts,
      force: false,
      frozen: false,
      dryRun: this.options.dryRun === true,
      outputFormat: this.options.outputFormat,
      command: 'remove',
      ignoreReleaseAge: this.options.ignoreReleaseAge,
      diagnostics,
      resolution: {
        originalManifest: result.value,
        stagedManifest: staged.manifest,
        nowMs,
        overrideCommand: releaseAgeOverrideCommand('remove', [
          this.options.packageName,
          ...(this.options.outputFormat === 'json' ? ['--json'] : []),
        ]),
      },
    });
    return install.execute();
  }
}
