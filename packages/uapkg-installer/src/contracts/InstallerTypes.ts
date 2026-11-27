import type { AssetHash, InstallPath, PackageName, PackageVersion, RegistryName } from '@uapkg/common-schema';
import type { RegistryVersion } from '@uapkg/registry-schema';

/**
 * The kind of change the installer will perform for a single package.
 */
export type InstallActionType = 'add' | 'update' | 'remove' | 'unchanged';

/**
 * A single planned action — fully self-describing so the executor does not
 * need to re-query the lockfile or registry at execution time.
 */
export interface InstallAction {
  readonly type: InstallActionType;
  readonly packageName: PackageName;
  readonly path: InstallPath;
  /** Target version (for add / update / unchanged). */
  readonly targetVersion?: PackageVersion;
  /** Previously installed version (for update / remove). */
  readonly currentVersion?: PackageVersion;
  readonly registry?: RegistryName;
  readonly integrity?: AssetHash;
  /** Byte size of the .tgz asset, if known from the registry manifest. */
  readonly sizeBytes?: number;
  /** Asset download URL for add / update. */
  readonly downloadUrl?: string;
  /** Registry version record used for claims verification (add / update). */
  readonly registryEntry?: RegistryVersion;
  /** Immutable registry type from the projected registry metadata, when known. */
  readonly registryType?: 'public' | 'private';
}

/**
 * Summary counts for the whole plan.
 */
export interface InstallSummary {
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  readonly unchanged: number;
  readonly totalBytes: number;
}

/**
 * The full plan returned by `InstallPlanner.plan()`. Safe to serialize
 * (e.g. for `--dry-run --json`).
 */
export interface InstallPlan {
  readonly actions: readonly InstallAction[];
  readonly summary: InstallSummary;
}

/** Terminal status of one package after a partial, verification-gated install. */
export type PackageInstallStatus =
  | 'installed'
  | 'failed'
  | 'skipped_no_verified_parent'
  | 'removed'
  | 'removal_deferred'
  | 'unchanged';

export interface PackageInstallOutcome {
  readonly packageName: PackageName;
  readonly status: PackageInstallStatus;
}

/** A reachable release activated by this installer, bound to the configured registry source and archive. */
export interface VerifiedRelease {
  /** Unique to this physical activation; grants remain bound to registry and release identity. */
  readonly activationId: string;
  readonly packageName: string;
  readonly registry: string;
  readonly registryId: string;
  readonly version: string;
  readonly integrity: AssetHash;
  readonly installedPath: string;
  readonly archivePath: string;
  readonly dependencies: readonly string[];
}

/**
 * Result of executing an install plan. Installation is partial by design:
 * one failed branch never rolls back or blocks unrelated verified branches.
 */
export interface InstallReport {
  readonly verifiedReleases: readonly VerifiedRelease[];
  readonly plan: InstallPlan;
  readonly outcomes: readonly PackageInstallOutcome[];
  /** Packages newly installed (verified add/update actions). */
  readonly installed: readonly PackageName[];
  /** Packages whose download/verification/extraction failed. */
  readonly failed: readonly PackageName[];
  /** Packages left uninstalled because no verified parent required them. */
  readonly skipped: readonly PackageName[];
  /** Installed/retained packages whose dependency closure is incomplete. */
  readonly incompleteClosure: readonly PackageName[];
  /** Owned package directories retained until the complete dependency graph is available. */
  readonly deferredRemovals: readonly PackageName[];
}

/**
 * Options accepted by {@link Installer}. Concurrency is NOT accepted here —
 * the installer reads `network.maxConcurrentDownloads` from config.
 */
export interface InstallerOptions {
  /** Absolute path to the directory containing `uapkg.json`. */
  readonly manifestRoot: string;
  /** If true, safety policies emit `SAFETY_OVERRIDDEN_BY_FORCE` instead of failing. */
  readonly force?: boolean;
  /** If true, the plan is produced but no IO is performed. */
  readonly dryRun?: boolean;
  /**
   * Direct dependency names declared by the trusted root manifest. These seed
   * the verification-gated traversal: a package is eligible only when a root
   * or an already verified parent requires it. When omitted, every lockfile
   * entry is treated as a trusted root request.
   */
  readonly rootDependencies?: readonly string[];
}
