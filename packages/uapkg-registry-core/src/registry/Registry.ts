import type { RegistryIdentifier, UnixTimestamp } from '@uapkg/common-schema';
import {
  createRegistryUnreachableDiagnostic,
  type Diagnostic,
  DiagnosticBag,
  ok,
  type Result,
} from '@uapkg/diagnostics';
import type { PackageRegistryManifest } from '@uapkg/registry-schema';
import type {
  RegistryAccessOptions,
  RegistryDescriptor,
  RegistryUpdateOptions,
  RegistryUpdateResult,
} from '#registry-core/contracts/RegistryCoreTypes.ts';
import { getRegistryLockPath } from '#registry-core/paths/RegistryPaths.ts';
import { type ResolvedVersion, resolveVersion } from '#registry-core/resolution/PackageResolver.ts';
import { RegistryCacheValidator } from '#registry-core/registry/RegistryCacheValidator.ts';
import { RegistryLock } from '#registry-core/registry/RegistryLock.ts';
import { RegistryMetadataReader } from '#registry-core/registry/RegistryMetadataReader.ts';
import { RegistryPackageReader } from '#registry-core/registry/RegistryPackageReader.ts';
import { evaluateSyncPolicy } from '#registry-core/registry/RegistrySyncPolicy.ts';
import { RegistryUpdater } from '#registry-core/registry/RegistryUpdater.ts';
import {
  redactRegistryUrlSecrets,
  sanitizeRegistryUrlForDisplay,
} from '#registry-core/registry/RegistryUrlSanitizer.ts';

/**
 * Represents one configured local registry cache.
 *
 * Exposes registry-level operations: sync, read manifests, resolve versions.
 */
export class Registry {
  public readonly id: RegistryIdentifier;
  public readonly descriptor: RegistryDescriptor;
  public readonly shortId: string;

  private hasUpdatedThisProcess = false;
  private initPromise?: Promise<Result<void>>;

  private readonly metadataReader: RegistryMetadataReader;
  private readonly cacheValidator: RegistryCacheValidator;
  private readonly updater: RegistryUpdater;
  private readonly packageReader: RegistryPackageReader;
  private ttlSeconds: number;

  private constructor(
    private readonly initialAlias: string,
    descriptor: RegistryDescriptor,
    id: RegistryIdentifier,
    shortId: string,
    gitBinary: string,
    ttlSeconds: number,
  ) {
    this.descriptor = descriptor;
    this.id = id;
    this.shortId = shortId;
    this.ttlSeconds = ttlSeconds;
    this.metadataReader = new RegistryMetadataReader(shortId);
    this.cacheValidator = new RegistryCacheValidator(shortId, id, this.metadataReader);
    this.updater = new RegistryUpdater(shortId, descriptor, gitBinary);
    this.packageReader = new RegistryPackageReader(shortId);
  }

  /** Factory — use this instead of `new`. */
  static create(
    initialAlias: string,
    descriptor: RegistryDescriptor,
    id: RegistryIdentifier,
    shortId: string,
    gitBinary: string,
    ttlSeconds: number,
  ): Registry {
    return new Registry(initialAlias, descriptor, id, shortId, gitBinary, ttlSeconds);
  }

  public registerAlias(alias: string, ttlSeconds?: number): void {
    if (alias.trim().length === 0) return;
    if (typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds)) {
      this.ttlSeconds = Math.min(this.ttlSeconds, ttlSeconds);
    }
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /** Ensure the local cache is up-to-date. */
  async ensureUpToDate(
    options?: RegistryUpdateOptions & { readonly logicalRegistryName?: string },
  ): Promise<Result<RegistryUpdateResult>> {
    const forced = options?.bypassFreshnessCheck ?? false;
    const cacheStateResult = await this.cacheValidator.inspect();
    if (!cacheStateResult.ok) return cacheStateResult;
    const cacheState = cacheStateResult.value;

    const decision = evaluateSyncPolicy({
      lastSyncAt: cacheState.lastRegistrySyncAt,
      ttlSeconds: this.ttlSeconds,
      hasUpdatedWithinProcessLifetime: cacheState.initialized && this.hasUpdatedThisProcess,
      forced,
    });

    if (decision === 'skip') {
      const reason: RegistryUpdateResult = this.hasUpdatedThisProcess ? 'UpdatedRecently' : 'AlreadyFresh';
      return ok(reason);
    }

    return this.performUpdate(options?.logicalRegistryName, forced);
  }

  /** Check whether system Git can read the configured remote without changing the cache. */
  async probeAccess(options: RegistryAccessOptions = {}): Promise<Result<void>> {
    return this.updater.probeAccess(options.interactive ?? false);
  }

  /** Read a package registry manifest from the local cache. */
  async getPackageManifest(
    packageName: string,
    logicalRegistryName?: string,
  ): Promise<Result<PackageRegistryManifest>> {
    const bag = new DiagnosticBag();
    const registryName = this.resolveDiagnosticRegistryName(logicalRegistryName);
    const readyResult = await this.ensureReady(registryName);
    if (!readyResult.ok) return readyResult as Result<never>;
    bag.mergeArray(readyResult.diagnostics);

    const packageResult = await this.packageReader.readPackageManifest(packageName, registryName);
    if (!packageResult.ok) {
      bag.mergeArray(packageResult.diagnostics);
      return bag.toFailure();
    }

    return bag.toResult(packageResult.value);
  }

  /** Resolve the best matching version for a package. */
  async resolvePackage(
    packageName: string,
    versionRange: string,
    registryName: string,
    current?: string,
  ): Promise<Result<ResolvedVersion>> {
    const bag = new DiagnosticBag();
    const manifestResult = await this.getPackageManifest(packageName, registryName);
    if (!manifestResult.ok) return manifestResult as Result<never>;
    bag.mergeArray(manifestResult.diagnostics);

    const resolved = resolveVersion(manifestResult.value, versionRange, registryName, current);
    if (!resolved.ok) {
      bag.mergeArray(resolved.diagnostics);
      return bag.toFailure();
    }

    return bag.toResult(resolved.value);
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------

  private async ensureReady(registryName: string): Promise<Result<void>> {
    if (!this.initPromise) {
      this.initPromise = this.ensureUpToDate({ logicalRegistryName: registryName }).then((r) =>
        r.ok ? ok(undefined, r.diagnostics) : r,
      );
    }
    const result = await this.initPromise;
    // Aliases share a cache and one Git sync. Each caller's recovery command
    // must use the name it selected, even if another alias started the sync.
    if (!result.diagnostics.length) return result;
    return {
      ...result,
      diagnostics: result.diagnostics.map((diagnostic) =>
        diagnostic.code === 'REGISTRY_UNREACHABLE' && diagnostic.data.registryName !== registryName
          ? createRegistryUnreachableDiagnostic({ ...diagnostic.data, registryName })
          : diagnostic,
      ),
    };
  }

  private async performUpdate(logicalRegistryName?: string, forced = false): Promise<Result<RegistryUpdateResult>> {
    const bag = new DiagnosticBag();
    const lock = new RegistryLock(getRegistryLockPath(this.shortId));

    const lockResult = await lock.acquire();
    if (!lockResult.ok) {
      bag.mergeArray(lockResult.diagnostics);
      return bag.toFailure();
    }

    try {
      // Revalidate both freshness and the full identifier after acquiring the
      // lock. Another process may have populated this shortened cache path.
      const cacheStateResult = await this.cacheValidator.inspect();
      if (!cacheStateResult.ok) return cacheStateResult;
      const cacheState = cacheStateResult.value;

      const recheck = evaluateSyncPolicy({
        lastSyncAt: cacheState.lastRegistrySyncAt,
        ttlSeconds: this.ttlSeconds,
        hasUpdatedWithinProcessLifetime: false,
        // Preserve an explicit force request across the lock boundary.  The
        // former hard-coded `false` made a fresh cache win the second
        // freshness check, so callers could not force a post-publish fetch.
        forced,
      });

      if (recheck === 'skip') {
        this.hasUpdatedThisProcess = true;
        return ok('AlreadyFresh');
      }

      const updateResult = await this.updater.update();
      if (!updateResult.ok) {
        const unreachable = this.toRegistryUnreachableDiagnostic(
          updateResult.diagnostics,
          cacheState.initialized,
          logicalRegistryName,
        );
        if (cacheState.initialized) {
          this.hasUpdatedThisProcess = true;
          return ok('Failed', [unreachable]);
        }
        bag.add(unreachable);
        return bag.toFailure();
      }

      const metadataResult = await this.writeMetadata();
      if (!metadataResult.ok) return metadataResult;
      this.hasUpdatedThisProcess = true;
      return ok('Updated');
    } finally {
      await lock.release();
    }
  }

  private async writeMetadata(): Promise<Result<void>> {
    const now = Math.floor(Date.now() / 1000) as UnixTimestamp;
    return this.metadataReader.write({ lastRegistrySyncAt: now, registryIdentifier: this.id });
  }

  private toRegistryUnreachableDiagnostic(
    diagnostics: readonly Diagnostic[],
    initialized: boolean,
    logicalRegistryName?: string,
  ) {
    const first = diagnostics[0];
    const cause = redactRegistryUrlSecrets(first?.message ?? 'Registry update failed.', this.descriptor.url);
    const httpStatus = this.extractHttpStatus(cause);
    const registryName = this.resolveDiagnosticRegistryName(logicalRegistryName);
    const safeUrl = sanitizeRegistryUrlForDisplay(this.descriptor.url);

    return createRegistryUnreachableDiagnostic({
      registryName,
      url: safeUrl,
      cause,
      initialized,
      httpStatus,
    });
  }

  private extractHttpStatus(text: string): number | undefined {
    const match = text.match(/\b([1-5][0-9][0-9])\b/);
    if (!match) return undefined;
    return Number(match[1]);
  }

  private resolveDiagnosticRegistryName(logicalRegistryName?: string): string {
    return logicalRegistryName?.trim() ? logicalRegistryName : this.initialAlias;
  }
}
