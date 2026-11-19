import { isDeepStrictEqual } from 'node:util';
import { parsePackageSpec } from '@uapkg/common';
import { DEFAULT_REGISTRY_ALIAS, RegistryNameSchema, VersionRangeSchema } from '@uapkg/common-schema';
import { createRegistryNotFoundDiagnostic, type Diagnostic } from '@uapkg/diagnostics';
import { DependencyMutator } from '@uapkg/package-manifest';
import { exactDeclaredVersion } from '@uapkg/registry-core';
import type { Dependency } from '@uapkg/package-manifest-schema';
import type { CompositionRoot } from '#cli/app/CompositionRoot.ts';
import { DependencyAddResolver } from '#cli/commands/add/DependencyAddResolver.ts';
import type { Command } from '#cli/commands/Command.ts';
import { InstallCommand } from '#cli/commands/InstallCommand.ts';
import { findDeclaredDependency, releaseAgeOverrideCommand } from '#cli/commands/PackageOperation.ts';

export interface AddCommandOptions {
  readonly spec: string;
  readonly pin: boolean;
  readonly dev: boolean;
  readonly registry?: string;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly outputFormat: 'text' | 'json';
  readonly ignoreReleaseAge?: boolean;
}

/**
 * `uapkg add <@Org/Name@range>` — parse the spec, mutate the manifest,
 * delegate to `InstallCommand` for the resolve/install/postinstall pipeline.
 *
 * This command is deliberately thin — it is a manifest-mutation shim around
 * `install`. All resolution/installation invariants live one level down.
 */
export class AddCommand implements Command {
  public constructor(
    private readonly root: CompositionRoot,
    private readonly options: AddCommandOptions,
  ) {}

  public async execute(): Promise<number> {
    const nowMs = Date.now();
    const specResult = parsePackageSpec(this.options.spec);
    if (!specResult.ok) return this.fail(specResult.diagnostics);
    const spec = specResult.value;
    const manifestResult = await this.root.packageManifest.readManifest();
    if (!manifestResult.ok) return this.fail(manifestResult.diagnostics);
    const lockResult = await this.root.packageManifest.readLockfileOptional();
    if (!lockResult.ok) return this.fail(lockResult.diagnostics);
    const original = manifestResult.value;
    const name = spec.name as unknown as string;
    const declared = findDeclaredDependency(original, name);
    const overrides = original.kind === 'project' ? original.overrides : undefined;
    const override = overrides && Object.hasOwn(overrides, name) ? overrides[name] : undefined;
    const locked =
      lockResult.value && Object.hasOwn(lockResult.value.packages, name)
        ? lockResult.value.packages[spec.name]
        : undefined;
    const existing: Dependency | undefined =
      declared?.dependency ??
      override ??
      (locked ? { version: VersionRangeSchema.parse(`^${locked.version}`), registry: locked.registry } : undefined);
    const newRoot = declared === undefined && override === undefined && locked === undefined;

    const registryInput =
      this.options.registry ??
      (existing
        ? (existing.registry ?? DEFAULT_REGISTRY_ALIAS)
        : ((this.root.config.get('registry') as string | null) ?? DEFAULT_REGISTRY_ALIAS));
    const registry = RegistryNameSchema.safeParse(registryInput);
    if (!registry.success) return this.fail([createRegistryNotFoundDiagnostic(registryInput)]);
    const commandDiagnostics = [...manifestResult.diagnostics, ...lockResult.diagnostics];
    let dependency: Dependency;
    let requiredVersion = spec.range === undefined ? undefined : exactDeclaredVersion(spec.range);
    if (newRoot && spec.range === undefined) {
      const resolved = await new DependencyAddResolver(this.root).resolve(spec, registry.data);
      if (!resolved.ok) return this.fail(resolved.diagnostics);
      dependency = resolved.value.dependency;
      requiredVersion = resolved.value.resolvedVersion;
      commandDiagnostics.push(...resolved.diagnostics);
    } else {
      dependency = {
        version: spec.range ?? existing!.version,
        ...(registry.data !== DEFAULT_REGISTRY_ALIAS ? { registry: registry.data } : {}),
        ...(existing?.path !== undefined ? { path: existing.path } : {}),
      };
    }

    const stagedManifest = new DependencyMutator().addDependency(original, name, dependency, {
      bucket: this.options.dev ? 'devDependencies' : (declared?.bucket ?? 'dependencies'),
      pin: this.options.pin,
    });

    // Delegate to Install for the resolve/execute/postinstall pipeline.
    const install = new InstallCommand(this.root, {
      force: this.options.force,
      frozen: false,
      dryRun: this.options.dryRun,
      outputFormat: this.options.outputFormat,
      ignoreReleaseAge: this.options.ignoreReleaseAge,
      command: 'add',
      diagnostics: commandDiagnostics,
      resolution: {
        originalManifest: original,
        ...(!isDeepStrictEqual(stagedManifest, original) ? { stagedManifest } : {}),
        previousLockfile: lockResult.value,
        updateTargets: newRoot ? undefined : [name],
        newRoots: newRoot ? [name] : [],
        requiredVersions: requiredVersion === undefined ? undefined : { [name]: requiredVersion },
        nowMs,
        overrideCommand: releaseAgeOverrideCommand('add', [
          this.options.spec,
          ...(this.options.dev ? ['--dev'] : []),
          ...(this.options.pin ? ['--pin'] : []),
          ...(this.options.registry ? ['--registry', this.options.registry] : []),
          ...(this.options.force ? ['--force'] : []),
          ...(this.options.dryRun ? ['--dry-run'] : []),
          ...(this.options.outputFormat === 'json' ? ['--json'] : []),
        ]),
      },
    });
    return install.execute();
  }

  private fail(diagnostics: readonly Diagnostic[]): number {
    if (this.options.outputFormat === 'json') {
      this.root.json.emit({ status: 'error', command: 'add', diagnostics });
    } else {
      this.root.diagnostics.reportAll(diagnostics);
    }
    return 1;
  }
}
