import { isDeepStrictEqual } from 'node:util';
import { parsePackageSpec } from '@uapkg/common';
import { DEFAULT_REGISTRY_ALIAS, VersionRangeSchema } from '@uapkg/common-schema';
import type { Diagnostic } from '@uapkg/diagnostics';
import { DependencyMutator } from '@uapkg/package-manifest';
import { exactDeclaredVersion } from '@uapkg/registry-core';
import type { Dependency } from '@uapkg/package-manifest-schema';
import type { CompositionRoot } from '#cli/app/CompositionRoot.ts';
import type { Command } from '#cli/commands/Command.ts';
import { InstallCommand } from '#cli/commands/InstallCommand.ts';
import { findDeclaredDependency, releaseAgeOverrideCommand } from '#cli/commands/PackageOperation.ts';
import { resolvePackageRegistry } from '#cli/commands/resolvePackageRegistry.ts';

export interface AddCommandOptions {
  readonly ignoreScripts?: boolean;
  readonly spec: string;
  readonly pin: boolean;
  readonly dev: boolean;
  readonly registry?: string;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly outputFormat: 'text' | 'json';
  readonly ignoreReleaseAge?: boolean;
}

/** Stage the requested dependency so its version can be resolved along with the rest of the project. */
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
    const name = spec.name;
    const registry = await resolvePackageRegistry(this.root, original, name, this.options.registry);
    if (!registry.ok) return this.fail(registry.diagnostics);
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
      (locked?.registry === registry.value ? { version: VersionRangeSchema.parse(`^${locked.version}`) } : undefined);
    const newRoot = existing === undefined;

    const dependency: Dependency = {
      version: spec.range ?? existing?.version ?? VersionRangeSchema.parse('*'),
      ...(registry.value !== DEFAULT_REGISTRY_ALIAS ? { registry: registry.value } : {}),
      ...(existing?.path !== undefined ? { path: existing.path } : {}),
    };
    const requiredVersion = spec.range === undefined ? undefined : exactDeclaredVersion(spec.range);
    const bucket = this.options.dev ? 'devDependencies' : (declared?.bucket ?? 'dependencies');
    const pin = this.options.pin;
    const mutator = new DependencyMutator();
    let stagedManifest = mutator.addDependency(original, name, dependency, { bucket, pin });
    // Every direct requirement for a package must resolve to the selected source.
    for (const otherBucket of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      const entries = original[otherBucket];
      if (otherBucket === bucket || !entries || !Object.hasOwn(entries, name)) continue;
      const other = entries[name];
      if ((other.registry ?? DEFAULT_REGISTRY_ALIAS) !== registry.value) {
        stagedManifest = mutator.addDependency(
          stagedManifest,
          name,
          { ...other, registry: registry.value },
          { bucket: otherBucket },
        );
      }
    }
    if (!pin && override && (override.registry ?? DEFAULT_REGISTRY_ALIAS) !== registry.value) {
      stagedManifest = mutator.setPin(stagedManifest, name, { ...override, registry: registry.value });
    }

    const install = new InstallCommand(this.root, {
      ignoreScripts: this.options.ignoreScripts,
      force: this.options.force,
      frozen: false,
      dryRun: this.options.dryRun,
      outputFormat: this.options.outputFormat,
      ignoreReleaseAge: this.options.ignoreReleaseAge,
      command: 'add',
      diagnostics: [...manifestResult.diagnostics, ...lockResult.diagnostics, ...registry.diagnostics],
      resolution: {
        originalManifest: original,
        ...(!isDeepStrictEqual(stagedManifest, original) ? { stagedManifest } : {}),
        ...(newRoot && spec.range === undefined ? { bareAdd: { name, bucket, pin } } : {}),
        previousLockfile: lockResult.value,
        updateTargets: [name],
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
