import type { Dependency, Lockfile, Manifest } from '@uapkg/package-manifest-schema';

/** Options shared by manifest operations. */
export interface ManifestOperationOptions {
  /** Root directory containing `uapkg.json`. */
  readonly manifestRoot: string;
}

/** Result from adding or removing a dependency. */
export interface DependencyChangeResult {
  readonly manifest: Manifest;
  readonly lockfile: Lockfile;
}

/** A resolved node in the dependency graph. */
export interface PackageNode {
  readonly name: string;
  readonly version: string;
  readonly registry: string;
  readonly integrity: string;
  readonly gitTree?: string;
  readonly dependencies: ReadonlyMap<string, PackageNode>;
}

/** Options for the Resolver. */
export interface ResolverOptions {
  /** Overrides to apply before resolution (from project manifest). */
  readonly overrides?: Record<string, Dependency>;
  /** If true, use lockfile and skip fresh resolution. */
  readonly frozen?: boolean;
  readonly previousLockfile?: Lockfile | null;
  /** Absent: reuse compatible locks. Empty: update all. Otherwise update the named roots. */
  readonly updateTargets?: readonly string[];
  readonly recursive?: boolean;
  /** Explicitly added roots absent from both the previous manifest and the lock. */
  readonly newRoots?: readonly string[];
  /** Exact selections made before a bare new add writes its caret declaration. */
  readonly requiredVersions?: Readonly<Record<string, string>>;
  readonly ignoreReleaseAge?: boolean;
  readonly minimumReleaseAge?: string;
  readonly nowMs?: number;
  readonly overrideCommand?: string;
}

export interface HeldBackRelease {
  readonly name: string;
  readonly registry: string;
  readonly selectedVersion: string;
  readonly blockedVersion: string;
  /** Present when a dependency introduced by the blocked version is still cooling down. */
  readonly blockedDependency?: { readonly name: string; readonly version: string };
  /** Publication time of the release causing the hold, in Unix seconds. */
  readonly publishedAt: number;
  readonly eligibleInSeconds: number;
}

export interface ManifestInstallReport {
  readonly manifest: Manifest;
  readonly previousLockfile: Lockfile | null;
  readonly lockfile: Lockfile;
  readonly heldBack: readonly HeldBackRelease[];
  readonly minimumReleaseAge: string;
}

export interface ManifestInstallOptions extends ResolverOptions {
  /** Snapshot captured by add/update/remove before staging declarations. */
  readonly originalManifest?: Manifest;
  readonly stagedManifest?: Manifest;
}

/** The result of dependency resolution. */
export interface ResolvedGraph {
  readonly heldBack: readonly HeldBackRelease[];
  /** One node per unique (registry + name + version). */
  readonly nodes: ReadonlyMap<string, PackageNode>;
  /** Direct dependencies of the root manifest. */
  readonly roots: readonly PackageNode[];
}
