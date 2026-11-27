import { CompositionRoot } from '#cli/app/CompositionRoot.ts';
import { WorkspaceRuntime } from '#cli/lifecycle/WorkspaceRuntime.ts';
import { pack } from '@uapkg/pack';
import { DiagnosticReporter } from '#cli/reporting/DiagnosticReporter.ts';
import type { Command } from '#cli/commands/Command.ts';

export interface PackCommandOptions {
  readonly ignoreScripts?: boolean;
  cwd: string;
  dryRun: boolean;
  allowMissingLfs: boolean;
  outFile?: string;
}

export class PackCommand implements Command {
  constructor(private readonly options: PackCommandOptions) {}

  async execute() {
    const result = await pack({
      cwd: this.options.cwd,
      ignoreScripts: this.options.ignoreScripts,
      resolveNode: async (selector, workspaceRoot) => {
        const root = new CompositionRoot({ cwd: workspaceRoot });
        return new WorkspaceRuntime(root).executable(selector);
      },
      dryRun: this.options.dryRun,
      allowMissingLfs: this.options.allowMissingLfs,
      outFile: this.options.outFile,
    });

    if (!result.ok) {
      new DiagnosticReporter().reportAll(result.diagnostics);
      return 1;
    }

    return 0;
  }
}
