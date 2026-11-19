import { join } from 'node:path';
import { DEFAULT_PACKAGE_MINIMUM_RELEASE_AGE } from '@uapkg/common';
import type { PackageName } from '@uapkg/common-schema';
import type { ConfigInstance } from '@uapkg/config';
import {
  createDependencyNotFoundDiagnostic,
  createForbiddenOverridesDiagnostic,
  createIntegrityMismatchDiagnostic,
  createLockfileOutOfSyncDiagnostic,
  DiagnosticBag,
  ok,
  type Result,
} from '@uapkg/diagnostics';
import type { Dependency, Lockfile, Manifest } from '@uapkg/package-manifest-schema';
import type { RegistryCore } from '@uapkg/registry-core';
import type {
  ManifestInstallOptions,
  ManifestInstallReport,
  ResolvedGraph,
  ResolverOptions,
} from '#package-manifest/contracts/ManifestTypes.ts';
import { LockfileReader } from '#package-manifest/io/LockfileReader.ts';
import { LockfileSyncIssueWriter } from '#package-manifest/io/LockfileSyncIssueWriter.ts';
import { LockfileWriter } from '#package-manifest/io/LockfileWriter.ts';
import { ManifestReader } from '#package-manifest/io/ManifestReader.ts';
import { ManifestWriter } from '#package-manifest/io/ManifestWriter.ts';
import { ManifestInstallWriter } from '#package-manifest/io/ManifestInstallWriter.ts';
import { LockfileSync } from '#package-manifest/resolver/LockfileSync.ts';
import { Resolver } from '#package-manifest/resolver/Resolver.ts';
import { type AddDependencyOptions, DependencyMutator } from '#package-manifest/core/DependencyMutator.ts';
import { type LockfileDiff, LockfileDiffer } from '#package-manifest/core/LockfileDiffer.ts';
import { LockfileSyncValidator } from '#package-manifest/core/LockfileSyncValidator.ts';
import { OutdatedChecker, type OutdatedEntry } from '#package-manifest/core/OutdatedChecker.ts';
import { WhyGraph, type WhyResult } from '#package-manifest/core/WhyGraph.ts';

export interface PackageManifestOptions {
  /** Absolute path to the directory containing `uapkg.json`. */
  readonly manifestRoot: string;
  /** The `RegistryCore` instance to use for registry operations. */
  readonly registryCore: RegistryCore;
  /** Optional `@uapkg/config` instance to share state. */
  readonly configInstance?: InstanceType<typeof ConfigInstance>;
}

/**
 * High-level facade for working with `uapkg.json` and `uapkg.lock`.
 *
 * All operations execute relative to `manifestRoot`. Composes small,
 * single-responsibility collaborators (reader/writer, resolver, mutator,
 * differ, outdated-checker, why-graph). Never throws — all fallible paths
 * return a `Result<T>` carrying diagnostics.
 */
export class PackageManifest {
  private readonly manifestRoot: string;
  private readonly config?: InstanceType<typeof ConfigInstance>;
  private readonly reader = new ManifestReader();
  private readonly writer = new ManifestWriter();
  private readonly lockReader = new LockfileReader();
  private readonly lockWriter = new LockfileWriter();
  private readonly installWriter = new ManifestInstallWriter();
  private readonly resolver: Resolver;
  private readonly lockSync = new LockfileSync();
  private readonly mutator = new DependencyMutator();
  private readonly differ = new LockfileDiffer();
  private readonly lockfileSyncValidator: LockfileSyncValidator;
  private readonly lockfileSyncIssueWriter = new LockfileSyncIssueWriter();
  private readonly outdated: OutdatedChecker;
  private readonly whyGraph = new WhyGraph();

  constructor(options: PackageManifestOptions) {
    this.manifestRoot = options.manifestRoot;
    this.config = options.configInstance;
    this.resolver = new Resolver(options.registryCore);
    this.outdated = new OutdatedChecker(options.registryCore);
    this.lockfileSyncValidator = new LockfileSyncValidator(
      options.registryCore,
      this.resolver,
      this.lockSync,
      this.differ,
      options.configInstance,
    );
  }

  // -------------------------------------------------------------------
  // Read / Write
  // -------------------------------------------------------------------

  async readManifest(): Promise<Result<Manifest>> {
    return this.reader.read(this.manifestRoot);
  }

  async writeManifest(manifest: Manifest): Promise<Result<void>> {
    return this.writer.write(this.manifestRoot, manifest);
  }

  async readLockfile(): Promise<Result<Lockfile>> {
    return this.lockReader.readRequired(this.manifestRoot);
  }

  async readLockfileOptional(): Promise<Result<Lockfile | null>> {
    return this.lockReader.readOptional(this.manifestRoot);
  }

  async writeLockfile(lockfile: Lockfile): Promise<Result<void>> {
    return this.lockWriter.write(this.manifestRoot, lockfile);
  }

  // -------------------------------------------------------------------
  // Validation + resolution
  // -------------------------------------------------------------------

  async validate(): Promise<Result<Manifest>> {
    const bag = new DiagnosticBag();
    const readResult = await this.readManifest();
    if (!readResult.ok) return readResult;

    const manifest = readResult.value;
    if (manifest.kind === 'plugin' && 'overrides' in manifest) {
      bag.add(createForbiddenOverridesDiagnostic('plugin', this.manifestRoot));
    }

    return bag.hasErrors() ? bag.toFailure() : ok(manifest);
  }

  private resolutionOptions(manifest: Manifest, options: ResolverOptions) {
    const configuredAge = this.config?.get('packages.resolution.minimumReleaseAge');
    return {
      ...options,
      overrides: manifest.kind === 'project' ? (manifest.overrides ?? options.overrides) : options.overrides,
      minimumReleaseAge:
        options.minimumReleaseAge ??
        (typeof configuredAge === 'string' ? configuredAge : DEFAULT_PACKAGE_MINIMUM_RELEASE_AGE),
      nowMs: options.nowMs ?? Date.now(),
    };
  }

  async resolve(options: ResolverOptions = {}): Promise<Result<ResolvedGraph>> {
    const manifest = await this.readManifest();
    if (!manifest.ok) return manifest;
    return this.resolver.resolve(manifest.value, this.resolutionOptions(manifest.value, options));
  }

  async install(options: ResolverOptions = {}): Promise<Result<Lockfile>> {
    const result = await this.installWithReport(options);
    return result.ok ? ok(result.value.lockfile, result.diagnostics) : result;
  }

  /** Select package versions using the requested manifest and the existing lockfile before saving any changes. */
  async installWithReport(options: ManifestInstallOptions = {}): Promise<Result<ManifestInstallReport>> {
    const bag = new DiagnosticBag();
    bag.mergeArray(this.config?.getDiagnostics() ?? []);
    const snapshot = options.stagedManifest ?? options.originalManifest;
    const manifestResult = snapshot ? ok(snapshot) : await this.readManifest();
    bag.mergeArray(manifestResult.diagnostics);
    if (!manifestResult.ok || bag.hasErrors()) return bag.toFailure();
    const manifest = manifestResult.value;
    const policy = this.resolutionOptions(manifest, options);

    if (options.frozen) {
      const locked = await this.readLockfile();
      bag.mergeArray(locked.diagnostics);
      if (!locked.ok) return bag.toFailure();
      const sync = await this.checkLockedManifest(manifest, locked.value, policy);
      bag.mergeArray(sync.diagnostics);
      return bag.toResult({
        manifest,
        lockfile: locked.value,
        previousLockfile: locked.value,
        minimumReleaseAge: policy.minimumReleaseAge,
        heldBack: [],
      });
    }

    const previous =
      options.previousLockfile !== undefined ? ok(options.previousLockfile) : await this.readLockfileOptional();
    bag.mergeArray(previous.diagnostics);
    if (!previous.ok) return bag.toFailure();

    const graph = await this.resolver.resolve(manifest, { ...policy, previousLockfile: previous.value });
    bag.mergeArray(graph.diagnostics);
    if (!graph.ok) return bag.toFailure();

    const lockfile = this.lockSync.buildLockfile(graph.value);
    const diff = this.differ.diff(previous.value, lockfile);
    // Updating a dependency can change a package's lockfile entry even when the package itself stays at the same version.
    // For the same package version from the same registry, the archive hash and Git tree must still match.
    for (const { name, previous: before, current: after } of diff.updated) {
      if (!before || !after || before.registry !== after.registry || before.version !== after.version) continue;
      if (before.integrity !== after.integrity) {
        bag.add(createIntegrityMismatchDiagnostic(`${name}@${after.version}`, before.integrity, after.integrity));
      }
      if (before.gitTree !== after.gitTree) {
        bag.add(
          createIntegrityMismatchDiagnostic(
            `${name}@${after.version} Git tree`,
            before.gitTree ?? '(absent)',
            after.gitTree ?? '(absent)',
          ),
        );
      }
    }
    if (bag.hasErrors()) return bag.toFailure();

    const writeLock = !previous.value || diff.added.length > 0 || diff.updated.length > 0 || diff.removed.length > 0;
    if (options.stagedManifest || writeLock) {
      const write = await this.installWriter.write(this.manifestRoot, [
        ...(options.stagedManifest ? [{ name: 'uapkg.json' as const, contents: this.writer.serialize(manifest) }] : []),
        ...(writeLock ? [{ name: 'uapkg.lock' as const, contents: this.lockWriter.serialize(lockfile) }] : []),
      ]);
      bag.mergeArray(write.diagnostics);
      if (!write.ok) return bag.toFailure();
    }
    return bag.toResult({
      manifest,
      previousLockfile: previous.value,
      lockfile,
      minimumReleaseAge: policy.minimumReleaseAge,
      heldBack: graph.value.heldBack,
    });
  }

  // -------------------------------------------------------------------
  // Mutation — delegates to DependencyMutator, persists via writer.
  // -------------------------------------------------------------------

  /** Add or replace a dependency and persist `uapkg.json`. */
  async addDependency(name: string, dep: Dependency, options: AddDependencyOptions = {}): Promise<Result<Manifest>> {
    const readResult = await this.readManifest();
    if (!readResult.ok) return readResult;
    const next = this.mutator.addDependency(readResult.value, name, dep, options);
    const writeResult = await this.writeManifest(next);
    if (!writeResult.ok) return writeResult as Result<never>;
    return ok(next);
  }

  /** Remove a dependency from every bucket and persist `uapkg.json`. */
  async removeDependency(name: string): Promise<Result<Manifest>> {
    const bag = new DiagnosticBag();
    const readResult = await this.readManifest();
    if (!readResult.ok) return readResult;
    const removed = this.mutator.removeDependency(readResult.value, name);
    if (!removed.removed) {
      bag.add(createDependencyNotFoundDiagnostic(name));
    }

    const writeResult = await this.writeManifest(removed.manifest);
    if (!writeResult.ok) return writeResult as Result<never>;
    return bag.toResult(removed.manifest);
  }

  // -------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------

  diffLockfile(previous: Lockfile | null, current: Lockfile): LockfileDiff {
    return this.differ.diff(previous, current);
  }

  async checkOutdated(): Promise<Result<OutdatedEntry[]>> {
    const bag = new DiagnosticBag();
    const manifestResult = await this.readManifest();
    if (!manifestResult.ok) return manifestResult as Result<never>;
    const lockResult = await this.getLockfileForReadOnly();
    if (!lockResult.ok) return lockResult as Result<never>;
    bag.mergeArray(lockResult.diagnostics);

    const outdatedResult = await this.outdated.check(manifestResult.value, lockResult.value);
    if (!outdatedResult.ok) {
      bag.mergeArray(outdatedResult.diagnostics);
      return bag.toFailure();
    }
    return bag.toResult(outdatedResult.value);
  }

  async explainWhy(target: PackageName): Promise<Result<WhyResult>> {
    const bag = new DiagnosticBag();
    const lockResult = await this.readLockfileOptional();
    if (!lockResult.ok) return lockResult as Result<never>;
    bag.mergeArray(lockResult.diagnostics);

    const graphResult = await this.resolve({ previousLockfile: lockResult.value, ignoreReleaseAge: true });
    if (!graphResult.ok) return graphResult as Result<never>;
    return bag.toResult(this.whyGraph.explain(graphResult.value, target));
  }

  async getLockfileForReadOnly(): Promise<Result<Lockfile>> {
    const bag = new DiagnosticBag();
    const lockResult = await this.readLockfileOptional();
    if (!lockResult.ok) return lockResult as Result<never>;
    bag.mergeArray(lockResult.diagnostics);

    if (lockResult.value !== null) {
      return bag.toResult(lockResult.value);
    }

    // This report only lists available versions, so it can include releases still in their cooldown period.
    const resolveResult = await this.resolve({ ignoreReleaseAge: true });
    if (!resolveResult.ok) {
      bag.mergeArray(resolveResult.diagnostics);
      return bag.toFailure();
    }

    const lockfile = this.lockSync.buildLockfile(resolveResult.value);
    return bag.toResult(lockfile);
  }

  async validateLockfileSync(lockfile: Lockfile): Promise<Result<void>> {
    const manifestResult = await this.readManifest();
    if (!manifestResult.ok) return manifestResult as Result<never>;
    return this.checkLockedManifest(manifestResult.value, lockfile);
  }

  private async checkLockedManifest(
    manifest: Manifest,
    lockfile: Lockfile,
    options?: ResolverOptions,
  ): Promise<Result<void>> {
    const bag = new DiagnosticBag();
    const issues = await this.lockfileSyncValidator.collectIssues(manifest, lockfile, bag, options);
    if (issues.length === 0) return bag.toResult(undefined);

    let logPath = join(this.manifestRoot, '.uapkg', 'logs', 'lockfile-sync.log');
    const logResult = await this.lockfileSyncIssueWriter.write(this.manifestRoot, issues);
    if (logResult.ok) logPath = logResult.value;
    bag.mergeArray(logResult.diagnostics);
    bag.add(createLockfileOutOfSyncDiagnostic(issues.slice(0, 3), issues.length, logPath));

    return bag.toFailure();
  }
}
