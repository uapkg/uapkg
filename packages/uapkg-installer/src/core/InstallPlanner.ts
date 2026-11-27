import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetHash, InstallPath, PackageName, PackageVersion, RegistryName } from '@uapkg/common-schema';
import { DiagnosticBag, ok, type Result } from '@uapkg/diagnostics';
import type { Lockfile } from '@uapkg/package-manifest-schema';
import { getRegistryRepoPath, type RegistryCore } from '@uapkg/registry-core';
import { RegistryMetaSchema, type RegistryType, type RegistryVersion } from '@uapkg/registry-schema';
import type { InstallAction, InstallPlan, InstallSummary } from '#installer/contracts/InstallerTypes.ts';
import type { DiskStateEntry } from '#installer/core/DiskStateInspector.ts';

/**
 * Diffs (previousLockfile, currentLockfile, diskState) → InstallPlan.
 *
 * Rules:
 *  - Package in current lockfile, not on disk        → `add`
 *  - Package in current lockfile, on disk, same ver  → `unchanged`
 *  - Package in current lockfile, on disk, different → `update`
 *  - Package in previous lockfile only                → `remove`
 *
 * Fetches asset URLs + integrity + size + the registry version record (for
 * install-time claims verification) from `RegistryCore` for add/update
 * actions. Pure with respect to disk (planner only reads registry metadata).
 */
export class InstallPlanner {
  constructor(private readonly registryCore: RegistryCore) {}

  async plan(
    currentLockfile: Lockfile,
    previousLockfile: Lockfile | null,
    diskState: ReadonlyMap<PackageName, DiskStateEntry>,
    orphanedActivations: ReadonlyMap<PackageName, PackageVersion> = new Map(),
  ): Promise<Result<InstallPlan>> {
    const bag = new DiagnosticBag();
    const actions: InstallAction[] = [];
    let totalBytes = 0;

    const current = currentLockfile.packages as Record<string, LockEntry>;
    const previous = previousLockfile?.packages as Record<string, LockEntry> | undefined;

    for (const [rawName, locked] of Object.entries(current)) {
      const name = rawName as PackageName;
      const state = diskState.get(name);
      const defaultPath = `Plugins/${name}` as unknown as InstallPath;
      const path = state?.path ?? defaultPath;

      if (!state?.exists || !state.hasManifest || state.installedName !== name) {
        const meta = await this.fetchAssetMeta(locked, name);
        if (!meta.ok) {
          bag.mergeArray(meta.diagnostics);
          continue;
        }
        if (meta.value.sizeBytes) totalBytes += meta.value.sizeBytes;
        actions.push({
          type: 'add',
          packageName: name,
          path,
          targetVersion: locked.version,
          registry: locked.registry,
          integrity: locked.integrity,
          sizeBytes: meta.value.sizeBytes,
          downloadUrl: meta.value.downloadUrl,
          registryEntry: meta.value.registryEntry,
          registryType: meta.value.registryType,
        });
        continue;
      }

      if (state.installedVersion !== locked.version) {
        const meta = await this.fetchAssetMeta(locked, name);
        if (!meta.ok) {
          bag.mergeArray(meta.diagnostics);
          continue;
        }
        if (meta.value.sizeBytes) totalBytes += meta.value.sizeBytes;
        actions.push({
          type: 'update',
          packageName: name,
          path,
          targetVersion: locked.version,
          currentVersion: state.installedVersion,
          registry: locked.registry,
          integrity: locked.integrity,
          sizeBytes: meta.value.sizeBytes,
          downloadUrl: meta.value.downloadUrl,
          registryEntry: meta.value.registryEntry,
          registryType: meta.value.registryType,
        });
        continue;
      }

      actions.push({
        type: 'unchanged',
        packageName: name,
        path,
        targetVersion: locked.version,
        registry: locked.registry,
      });
    }

    // Removals (in previous but not in current)
    const removals = new Map(orphanedActivations);
    for (const [name, entry] of Object.entries(previous ?? {})) {
      if (!Object.hasOwn(current, name)) removals.set(name as PackageName, entry.version);
    }
    for (const [name, version] of removals) {
      if (Object.hasOwn(current, name)) continue;
      actions.push({
        type: 'remove',
        packageName: name,
        path: `Plugins/${name}` as InstallPath,
        currentVersion: version,
      });
    }

    const summary = this.summarize(actions, totalBytes);
    if (bag.hasErrors()) return bag.toFailure();
    return ok({ actions, summary });
  }

  private summarize(actions: readonly InstallAction[], totalBytes: number): InstallSummary {
    let added = 0,
      updated = 0,
      removed = 0,
      unchanged = 0;
    for (const a of actions) {
      if (a.type === 'add') added++;
      else if (a.type === 'update') updated++;
      else if (a.type === 'remove') removed++;
      else unchanged++;
    }
    return { added, updated, removed, unchanged, totalBytes };
  }

  private async fetchAssetMeta(
    locked: LockEntry,
    name: PackageName,
  ): Promise<
    Result<{
      readonly downloadUrl: string;
      readonly sizeBytes?: number;
      readonly registryEntry: RegistryVersion;
      readonly registryType?: RegistryType;
    }>
  > {
    const bag = new DiagnosticBag();
    const registryResult = this.registryCore.getOrCreateRegistry(locked.registry);
    if (!registryResult.ok) {
      bag.mergeArray(registryResult.diagnostics);
      return bag.toFailure();
    }
    const pkgManifest = await registryResult.value.getPackageManifest(name, locked.registry);
    if (!pkgManifest.ok) {
      bag.mergeArray(pkgManifest.diagnostics);
      return bag.toFailure();
    }
    const versionEntry = (pkgManifest.value.versions as Record<string, RegistryVersion>)[
      locked.version as unknown as string
    ];
    if (!versionEntry) {
      bag.addError(
        'INSTALL_VERSION_NOT_IN_REGISTRY',
        `Version ${locked.version} of "${name}" is not present in registry "${locked.registry}".`,
        { packageName: name, version: locked.version, registry: locked.registry },
      );
      return bag.toFailure();
    }
    const registryType = await this.readRegistryType(locked.registry, registryResult.value.shortId);
    if (!registryType.ok) {
      bag.mergeArray(registryType.diagnostics);
      return bag.toFailure();
    }
    if (registryType.value === 'public' && versionEntry.gitTree === undefined) {
      bag.addError(
        'INSTALL_PUBLIC_REGISTRY_GITTREE_REQUIRED',
        `Public registry version "${name}@${locked.version}" does not include the required gitTree.`,
        { packageName: name, version: locked.version, registry: locked.registry },
      );
      return bag.toFailure();
    }
    return ok({
      downloadUrl: versionEntry.releaseFiles.package.url,
      sizeBytes: versionEntry.releaseFiles.package.integrity.size,
      registryEntry: versionEntry,
      registryType: registryType.value,
    });
  }

  /**
   * Read the immutable registry type from the projected registry metadata.
   * Missing, invalid, or unsupported metadata fails closed because package
   * validation cannot safely choose public or private policy without it.
   */
  private async readRegistryType(registry: RegistryName, shortId: string): Promise<Result<RegistryType>> {
    function invalidRegistryMetaResult(issues: readonly string[]): Result<never> {
      const bag = new DiagnosticBag();
      bag.addError(
        'INSTALL_REGISTRY_META_INVALID',
        `Metadata for registry "${registry}" is missing, invalid, or uses an unsupported schema version.`,
        { registry, shortId, issues },
      );
      return bag.toFailure();
    }

    const metaPath = join(getRegistryRepoPath(shortId), '.uapkg', 'registry.meta.json');
    if (!existsSync(metaPath)) {
      return invalidRegistryMetaResult(['Required registry metadata file is missing.']);
    }
    try {
      const raw = await readFile(metaPath, 'utf8');
      const parsed = RegistryMetaSchema.safeParse(JSON.parse(raw) as unknown);
      if (!parsed.success) {
        return invalidRegistryMetaResult(parsed.error.issues.map((issue) => issue.message));
      }
      return ok(parsed.data.registry.registryType);
    } catch (error) {
      return invalidRegistryMetaResult([error instanceof Error ? error.message : String(error)]);
    }
  }
}

// Local aliases — avoid importing schema types directly to keep this file small.
interface LockEntry {
  readonly version: PackageVersion;
  readonly registry: RegistryName;
  readonly integrity: AssetHash;
  readonly path?: InstallPath;
}
