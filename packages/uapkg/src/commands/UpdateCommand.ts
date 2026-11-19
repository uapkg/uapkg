import { isDeepStrictEqual } from 'node:util';
import { parsePackageSpec } from '@uapkg/common';
import type { PackageName } from '@uapkg/common-schema';
import {
  createInvalidPackageSpecDiagnostic,
  createPackageNotFoundDiagnostic,
  type Diagnostic,
} from '@uapkg/diagnostics';
import { DependencyMutator } from '@uapkg/package-manifest';
import { exactDeclaredVersion } from '@uapkg/registry-core';
import type { CompositionRoot } from '#cli/app/CompositionRoot.ts';
import type { Command } from '#cli/commands/Command.ts';
import { InstallCommand } from '#cli/commands/InstallCommand.ts';
import { findDeclaredDependency, releaseAgeOverrideCommand } from '#cli/commands/PackageOperation.ts';

export interface UpdateCommandOptions {
  readonly specs: readonly string[];
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly recursive?: boolean;
  readonly ignoreReleaseAge?: boolean;
  readonly outputFormat: 'text' | 'json';
}

/** Collect the requested updates so the resolver chooses versions that work together before installation. */
export class UpdateCommand implements Command {
  public constructor(
    private readonly root: CompositionRoot,
    private readonly options: UpdateCommandOptions,
  ) {}

  public async execute(): Promise<number> {
    const nowMs = Date.now();
    const manifestResult = await this.root.packageManifest.readManifest();
    if (!manifestResult.ok) return this.fail(manifestResult.diagnostics);
    const lockResult = await this.root.packageManifest.readLockfileOptional();
    if (!lockResult.ok) return this.fail(lockResult.diagnostics);

    let stagedManifest = manifestResult.value;
    const targets: string[] = [];
    const requiredVersions: Record<string, string> = Object.create(null);
    const diagnostics: Diagnostic[] = [];
    const mutator = new DependencyMutator();
    for (const rawSpec of this.options.specs) {
      const parsed = parsePackageSpec(rawSpec);
      if (!parsed.ok) {
        diagnostics.push(...parsed.diagnostics);
        continue;
      }
      const spec = parsed.value;
      if (spec.org) {
        diagnostics.push(
          createInvalidPackageSpecDiagnostic(
            rawSpec,
            'scoped specifiers (@org/name) are reserved for a future registry iteration',
          ),
        );
        continue;
      }
      const name = spec.name as unknown as string;
      const declared = findDeclaredDependency(stagedManifest, name);
      if (!declared) {
        diagnostics.push(createPackageNotFoundDiagnostic(name as PackageName, String(stagedManifest.name)));
        continue;
      }
      targets.push(name);
      if (spec.range !== undefined) {
        const exact = exactDeclaredVersion(spec.range);
        if (exact === undefined) delete requiredVersions[name];
        else requiredVersions[name] = exact;
      }
      if (spec.range !== undefined && spec.range !== declared.dependency.version) {
        stagedManifest = mutator.addDependency(
          stagedManifest,
          name,
          {
            ...declared.dependency,
            version: spec.range,
          },
          { bucket: declared.bucket },
        );
      }
    }
    if (diagnostics.length > 0) return this.fail(diagnostics);

    return new InstallCommand(this.root, {
      command: 'update',
      force: this.options.force,
      frozen: false,
      dryRun: this.options.dryRun,
      ignoreReleaseAge: this.options.ignoreReleaseAge,
      outputFormat: this.options.outputFormat,
      diagnostics: [...manifestResult.diagnostics, ...lockResult.diagnostics],
      resolution: {
        originalManifest: manifestResult.value,
        ...(!isDeepStrictEqual(stagedManifest, manifestResult.value) ? { stagedManifest } : {}),
        previousLockfile: lockResult.value,
        updateTargets: [...new Set(targets)],
        requiredVersions,
        recursive: this.options.recursive === true,
        nowMs,
        overrideCommand: releaseAgeOverrideCommand('update', [
          ...this.options.specs,
          ...(this.options.recursive ? ['--recursive'] : []),
          ...(this.options.force ? ['--force'] : []),
          ...(this.options.dryRun ? ['--dry-run'] : []),
          ...(this.options.outputFormat === 'json' ? ['--json'] : []),
        ]),
      },
    }).execute();
  }

  private fail(diagnostics: readonly Diagnostic[]): number {
    if (this.options.outputFormat === 'json') this.root.json.emit({ status: 'error', command: 'update', diagnostics });
    else this.root.diagnostics.reportAll(diagnostics);
    return 1;
  }
}
