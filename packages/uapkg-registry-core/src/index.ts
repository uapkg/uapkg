// ---------------------------------------------------------------------------
// @uapkg/registry-core — public API
// ---------------------------------------------------------------------------

export type {
  RegistryAccessOptions,
  RegistryCoreOptions,
  RegistryDescriptor,
  RegistryInstantiationResult,
  RegistryLockData,
  RegistryMetadata,
  RegistryUpdateOptions,
  RegistryUpdateResult,
  SyncDecision,
  SyncPolicyInput,
} from '#registry-core/contracts/RegistryCoreTypes.ts';
export { RegistryCore } from '#registry-core/core/RegistryCore.ts';
export {
  getRegistryCachePath,
  getRegistryLockPath,
  getRegistryMetadataPath,
  getRegistryPackagesPath,
  getRegistryRepoPath,
  getRegistryRoot,
} from '#registry-core/paths/RegistryPaths.ts';
export {
  type GitCommandRunner,
  type GitInteractionMode,
  type GitProcessSpawner,
  GitRunner,
  type GitRunOptions,
} from '#registry-core/registry/GitRunner.ts';
export { Registry } from '#registry-core/registry/Registry.ts';
export { RegistryLock } from '#registry-core/registry/RegistryLock.ts';
export { RegistryMetadataReader } from '#registry-core/registry/RegistryMetadataReader.ts';
export { RegistryPackageReader } from '#registry-core/registry/RegistryPackageReader.ts';
export { evaluateSyncPolicy } from '#registry-core/registry/RegistrySyncPolicy.ts';
export { RegistryUpdater } from '#registry-core/registry/RegistryUpdater.ts';
export {
  redactRegistryUrlSecrets,
  sanitizeRegistryUrlForDisplay,
} from '#registry-core/registry/RegistryUrlSanitizer.ts';
export { type ResolvedVersion, resolveVersion } from '#registry-core/resolution/PackageResolver.ts';
export { SemverSelectionPolicy } from '#registry-core/resolution/SemverSelectionPolicy.ts';
export type { PackageRegistryManifest, RegistryVersion } from '@uapkg/registry-schema';
export {
  exactDeclaredVersion,
  explicitMinimumVersion,
  releaseAgeEligible,
  releaseAgeRemainingSeconds,
} from '#registry-core/resolution/ReleaseAgePolicy.ts';
