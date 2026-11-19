import type { PackageName } from '@uapkg/common-schema';
import type { Dependency, Lockfile, Manifest } from '@uapkg/package-manifest-schema';
import type { DependencyBucket } from '#package-manifest/core/DependencyMutator.ts';

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
  /** Omit to reuse compatible locked versions. Pass an empty list to update all packages, or name the packages to update. */
  readonly updateTargets?: readonly string[];
  readonly recursive?: boolean;
  /** Packages the user explicitly added that appear in neither the original manifest nor the previous lockfile. */
  readonly newRoots?: readonly string[];
  /** Exact versions requested on the command line. */
  readonly requiredVersions?: Readonly<Record<string, string>>;
  readonly ignoreReleaseAge?: boolean;
  readonly minimumReleaseAge?: string;
  /** Defaults to true. Set to false to exempt packages introduced exclusively by a new add. */
  readonly applyReleaseAgeToNewPackages?: boolean;
  readonly nowMs?: number;
  readonly overrideCommand?: string;
}

export interface HeldBackRelease {
  readonly name: string;
  readonly registry: string;
  readonly selectedVersion: string;
  readonly blockedVersion: string;
  /** The dependency release that must reach the minimum age before this package can update, if any. */
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
  /** The manifest as it was before `add`, `update`, or `remove` changed its dependencies. */
  readonly originalManifest?: Manifest;
  readonly stagedManifest?: Manifest;
  /** Replace the temporary wildcard for a new bare add with a caret range based on the resolved version. */
  readonly bareAdd?: { readonly name: PackageName; readonly bucket: DependencyBucket; readonly pin: boolean };
}

/** The result of dependency resolution. */
export interface ResolvedGraph {
  readonly heldBack: readonly HeldBackRelease[];
  /** One node per unique (registry + name + version). */
  readonly nodes: ReadonlyMap<string, PackageNode>;
  /** Direct dependencies of the root manifest. */
  readonly roots: readonly PackageNode[];
}
