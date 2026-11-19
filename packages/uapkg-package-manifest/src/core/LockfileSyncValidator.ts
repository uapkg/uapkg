import type { ConfigInstance } from '@uapkg/config';
import type { DiagnosticBag } from '@uapkg/diagnostics';
import type { Lockfile, Manifest } from '@uapkg/package-manifest-schema';
import type { RegistryCore } from '@uapkg/registry-core';
import type { ResolverOptions } from '#package-manifest/contracts/ManifestTypes.ts';
import { LockfileSync } from '#package-manifest/resolver/LockfileSync.ts';
import { Resolver } from '#package-manifest/resolver/Resolver.ts';
import { LockfileDiffer } from '#package-manifest/core/LockfileDiffer.ts';
import { type LockfileSyncIssue, sortLockfileSyncIssues } from '#package-manifest/core/LockfileSyncIssue.ts';

/** Validate the locked graph and its registry metadata without selecting any upgrades. */
export class LockfileSyncValidator {
  public constructor(
    registryCore: RegistryCore,
    private readonly resolver: Resolver = new Resolver(registryCore),
    private readonly lockSync = new LockfileSync(),
    private readonly differ = new LockfileDiffer(),
    private readonly config?: InstanceType<typeof ConfigInstance>,
  ) {}

  public async collectIssues(
    manifest: Manifest,
    lockfile: Lockfile,
    diagnostics?: DiagnosticBag,
    options?: ResolverOptions,
  ): Promise<LockfileSyncIssue[]> {
    const issues: LockfileSyncIssue[] = [];
    const registries = this.config?.get('registries');
    for (const registry of new Set(Object.values(lockfile.packages).map((entry) => entry.registry))) {
      if (registries && typeof registries === 'object' && !Object.hasOwn(registries, registry)) {
        issues.push({
          severity: 'error',
          code: 'LOCKFILE_REGISTRY_UNCONFIGURED',
          message: `Registry "${registry}" is referenced by the lockfile but is not configured.`,
        });
      }
    }
    const graph = await this.resolver.resolve(manifest, {
      ...options,
      previousLockfile: lockfile,
      frozen: true,
      overrides: options?.overrides ?? (manifest.kind === 'project' ? manifest.overrides : undefined),
    });
    diagnostics?.mergeArray(graph.diagnostics);
    if (!graph.ok) {
      for (const diagnostic of graph.diagnostics.filter((item) => item.level === 'error')) {
        issues.push({ severity: 'error', code: `LOCKFILE_EXPECTED_${diagnostic.code}`, message: diagnostic.message });
      }
      return sortLockfileSyncIssues(issues);
    }

    const diff = this.differ.diff(lockfile, this.lockSync.buildLockfile(graph.value));
    for (const { name } of diff.removed) {
      issues.push({
        severity: 'error',
        code: 'LOCKFILE_PACKAGE_EXTRA',
        packageName: name,
        message: `"${name}" is not reachable from the manifest.`,
      });
    }
    for (const { name } of diff.added) {
      issues.push({
        severity: 'error',
        code: 'LOCKFILE_PACKAGE_MISSING',
        packageName: name,
        message: `"${name}" is missing from the lockfile.`,
      });
    }
    for (const { name, previous, current } of diff.updated) {
      let field = 'dependency graph';
      let code = 'LOCKFILE_PACKAGE_MISMATCH';
      if (previous?.integrity !== current?.integrity) {
        field = 'integrity hash';
        code = 'LOCKFILE_INTEGRITY_MISMATCH';
      } else if (previous?.gitTree !== current?.gitTree) {
        field = 'Git tree';
        code = 'LOCKFILE_GITTREE_MISMATCH';
      }
      issues.push({
        severity: 'error',
        code,
        packageName: name,
        message: `The locked ${field} of "${name}" differs from the registry record.`,
      });
    }
    return sortLockfileSyncIssues(issues);
  }

  public topIssues(issues: readonly LockfileSyncIssue[], count: number): readonly LockfileSyncIssue[] {
    return sortLockfileSyncIssues(issues).slice(0, count);
  }
}
