// ---------------------------------------------------------------------------
// @uapkg/package-manifest — public API
// ---------------------------------------------------------------------------

export type {
  DependencyChangeResult,
  HeldBackRelease,
  ManifestInstallOptions,
  ManifestInstallReport,
  ManifestOperationOptions,
  PackageNode,
  ResolvedGraph,
  ResolverOptions,
} from '#package-manifest/contracts/ManifestTypes.ts';
export {
  type AddDependencyOptions,
  type DependencyBucket,
  DependencyMutator,
  type RemoveDependencyResult,
} from '#package-manifest/core/DependencyMutator.ts';
export { DevDependencyPolicy } from '#package-manifest/core/DevDependencyPolicy.ts';
export { InstallPathResolver, type ResolvedInstallPath } from '#package-manifest/core/InstallPathResolver.ts';
export { type LockfileChange, type LockfileDiff, LockfileDiffer } from '#package-manifest/core/LockfileDiffer.ts';
export {
  type LockfileSyncIssue,
  type LockfileSyncIssueSeverity,
  sortLockfileSyncIssues,
} from '#package-manifest/core/LockfileSyncIssue.ts';
export { LockfileSyncValidator } from '#package-manifest/core/LockfileSyncValidator.ts';
export { OutdatedChecker, type OutdatedEntry, type OutdatedStatus } from '#package-manifest/core/OutdatedChecker.ts';
export { PackageManifest, type PackageManifestOptions } from '#package-manifest/core/PackageManifest.ts';
export { WhyGraph, type WhyPath, type WhyResult } from '#package-manifest/core/WhyGraph.ts';
export { LockfileReader } from '#package-manifest/io/LockfileReader.ts';
export { LockfileSyncIssueWriter } from '#package-manifest/io/LockfileSyncIssueWriter.ts';
export { LockfileWriter } from '#package-manifest/io/LockfileWriter.ts';
export { ManifestReader } from '#package-manifest/io/ManifestReader.ts';
export { ManifestWriter } from '#package-manifest/io/ManifestWriter.ts';
export { LockfileSync } from '#package-manifest/resolver/LockfileSync.ts';
export { Resolver } from '#package-manifest/resolver/Resolver.ts';
