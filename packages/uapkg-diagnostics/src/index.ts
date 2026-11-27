// ---------------------------------------------------------------------------
// @uapkg/diagnostics — public API
// ---------------------------------------------------------------------------

export type { DiagnosticBase, DiagnosticEmitPolicy } from '#diagnostics/base/Diagnostic.ts';
export { createDiagnostic } from '#diagnostics/base/Diagnostic.ts';
export { DiagnosticBag } from '#diagnostics/base/DiagnosticBag.ts';
export { createDiagnosticFingerprint } from '#diagnostics/base/DiagnosticFingerprint.ts';
// Base primitives
export type { DiagnosticLevel } from '#diagnostics/base/DiagnosticLevel.ts';
export type { Result, ResultFail, ResultOk } from '#diagnostics/base/Result.ts';
export { fail, fromDiagnostics, ok } from '#diagnostics/base/Result.ts';
// --- Config family ---
export type {
  ConfigDiagnostic,
  ConfigInvalidJsonDiagnostic,
  ConfigInvalidValueDiagnostic,
  ConfigTypeMismatchDiagnostic,
  ConfigUnknownKeyDiagnostic,
  ConfigUnresolvedDefaultRegistryDiagnostic,
} from '#diagnostics/config/ConfigDiagnostics.ts';
export {
  createConfigInvalidJsonDiagnostic,
  createConfigInvalidValueDiagnostic,
  createConfigTypeMismatchDiagnostic,
  createConfigUnknownKeyDiagnostic,
  createConfigUnresolvedDefaultRegistryDiagnostic,
} from '#diagnostics/config/ConfigDiagnostics.ts';
// --- Control-plane family ---
export type {
  ControlPlaneCommandFailedDiagnostic,
  ControlPlaneCommandFailedDiagnosticData,
  ControlPlaneDiagnostic,
  LoginAccessDeniedDiagnostic,
  LoginAuthorizationResponseInvalidDiagnostic,
  LoginAuthorizationTimeoutDiagnostic,
  LoginDiagnosticByCode,
  LoginDiagnosticCode,
  LoginDiagnosticData,
  LoginFailedDiagnostic,
  LoginOAuthErrorDiagnostic,
  LoginReauthorizationConflictDiagnostic,
} from '#diagnostics/controlPlane/ControlPlaneDiagnostics.ts';
export { createControlPlaneCommandFailedDiagnostic } from '#diagnostics/controlPlane/ControlPlaneDiagnostics.ts';
// --- General family ---
export type {
  GeneralDiagnostic,
  IoErrorDiagnostic,
  ParseErrorDiagnostic,
  UnknownErrorDiagnostic,
} from '#diagnostics/general/GeneralDiagnostics.ts';
export {
  createIoErrorDiagnostic,
  createParseErrorDiagnostic,
  createUnknownErrorDiagnostic,
} from '#diagnostics/general/GeneralDiagnostics.ts';
// --- Installer family ---
export type {
  DiskRemoveFailedDiagnostic,
  DownloadFailedDiagnostic,
  DownloadHttpStatusDiagnostic,
  ExtractionFailedDiagnostic,
  InstallerDiagnostic,
  IntegrityMismatchDiagnostic,
  NetworkRetriesExhaustedDiagnostic,
  NetworkTimeoutDiagnostic,
} from '#diagnostics/installer/InstallerDiagnostics.ts';
export {
  createDiskRemoveFailedDiagnostic,
  createDownloadFailedDiagnostic,
  createDownloadHttpStatusDiagnostic,
  createExtractionFailedDiagnostic,
  createIntegrityMismatchDiagnostic,
  createNetworkRetriesExhaustedDiagnostic,
  createNetworkTimeoutDiagnostic,
} from '#diagnostics/installer/InstallerDiagnostics.ts';
// --- Manifest family ---
export type {
  DependencyNotFoundDiagnostic,
  ForbiddenOverridesDiagnostic,
  LockfileInvalidDiagnostic,
  LockfileMissingDiagnostic,
  LockfileOutOfSyncDiagnostic,
  ManifestDiagnostic,
  ManifestInvalidDiagnostic,
  ManifestReadErrorDiagnostic,
  ManifestWriteErrorDiagnostic,
  UnresolvedRegistryDiagnostic,
} from '#diagnostics/manifest/ManifestDiagnostics.ts';
export {
  createDependencyNotFoundDiagnostic,
  createForbiddenOverridesDiagnostic,
  createLockfileInvalidDiagnostic,
  createLockfileMissingDiagnostic,
  createLockfileOutOfSyncDiagnostic,
  createManifestInvalidDiagnostic,
  createManifestReadErrorDiagnostic,
  createManifestWriteErrorDiagnostic,
  createUnresolvedRegistryDiagnostic,
} from '#diagnostics/manifest/ManifestDiagnostics.ts';
// --- Pack family ---
export type {
  CyclicSymlinkDiagnostic,
  InvalidPathDiagnostic,
  LfsSkippedDiagnostic,
  NoFilesSelectedDiagnostic,
  OutFileIsDirectoryDiagnostic,
  PackDiagnostic,
  PluginRootNotFoundDiagnostic,
  SymlinkOutsideRootDiagnostic,
  UnresolvedLfsDiagnostic,
  UpluginMissingDiagnostic,
} from '#diagnostics/pack/PackDiagnostics.ts';
export {
  createCyclicSymlinkDiagnostic,
  createInvalidPathDiagnostic,
  createLfsSkippedDiagnostic,
  createNoFilesSelectedDiagnostic,
  createOutFileIsDirectoryDiagnostic,
  createPluginRootNotFoundDiagnostic,
  createSymlinkOutsideRootDiagnostic,
  createUnresolvedLfsDiagnostic,
  createUpluginMissingDiagnostic,
} from '#diagnostics/pack/PackDiagnostics.ts';
export type { LifecycleDiagnostic } from '#diagnostics/lifecycle/LifecycleDiagnostics.ts';
// --- Publishing family ---
export type {
  PublishDiagnosticFact,
  PublishDiagnosticResource,
  PublishingDiagnostic,
  PublishRequestFailedDiagnostic,
  PublishRequestFailedDiagnosticData,
} from '#diagnostics/publishing/PublishingDiagnostics.ts';
export { createPublishRequestFailedDiagnostic } from '#diagnostics/publishing/PublishingDiagnostics.ts';
// --- Registry family ---
export type {
  CacheCorruptDiagnostic,
  CacheIdentifierCollisionDiagnostic,
  CacheReadErrorDiagnostic,
  GitErrorDiagnostic,
  LockAcquisitionFailedDiagnostic,
  NetworkErrorDiagnostic,
  PackageRegistryAmbiguousDiagnostic,
  RegistryDiagnostic,
  RegistryNotFoundDiagnostic,
  RegistryUnreachableDiagnostic,
  SchemaInvalidDiagnostic,
} from '#diagnostics/registry/RegistryDiagnostics.ts';
export {
  createCacheCorruptDiagnostic,
  createCacheIdentifierCollisionDiagnostic,
  createCacheReadErrorDiagnostic,
  createGitErrorDiagnostic,
  createLockAcquisitionFailedDiagnostic,
  createNetworkErrorDiagnostic,
  createPackageRegistryAmbiguousDiagnostic,
  createRegistryNotFoundDiagnostic,
  createRegistryUnreachableDiagnostic,
  createSchemaInvalidDiagnostic,
} from '#diagnostics/registry/RegistryDiagnostics.ts';
// --- Registry-tools family ---
export type {
  RegistryToolsDependencyNotInRegistryDiagnostic,
  RegistryToolsDependencyRangeUnreachableDiagnostic,
  RegistryToolsDiagnostic,
  RegistryToolsExternalRegistryDeniedDiagnostic,
  RegistryToolsExternalRegistryNotAllowedDiagnostic,
  RegistryToolsIntegrityMismatchDiagnostic,
  RegistryToolsOfficialPolicyViolationDiagnostic,
  RegistryToolsPackageMissingDiagnostic,
  RegistryToolsPackageSourceMismatchDiagnostic,
  RegistryToolsPathMismatchDiagnostic,
  RegistryToolsReleaseFileNameInvalidDiagnostic,
  RegistryToolsRemovalDeniedDiagnostic,
  RegistryToolsUnknownKeyDiagnostic,
  RegistryToolsVersionExistsDiagnostic,
  RegistryToolsVersionNotFoundDiagnostic,
  RegistryToolsVersionsUnsortedDiagnostic,
} from '#diagnostics/registryTools/RegistryToolsDiagnostics.ts';
export {
  createRegistryToolsDependencyNotInRegistryDiagnostic,
  createRegistryToolsDependencyRangeUnreachableDiagnostic,
  createRegistryToolsExternalRegistryDeniedDiagnostic,
  createRegistryToolsExternalRegistryNotAllowedDiagnostic,
  createRegistryToolsIntegrityMismatchDiagnostic,
  createRegistryToolsOfficialPolicyViolationDiagnostic,
  createRegistryToolsPackageMissingDiagnostic,
  createRegistryToolsPackageSourceMismatchDiagnostic,
  createRegistryToolsPathMismatchDiagnostic,
  createRegistryToolsReleaseFileNameInvalidDiagnostic,
  createRegistryToolsRemovalDeniedDiagnostic,
  createRegistryToolsUnknownKeyDiagnostic,
  createRegistryToolsVersionExistsDiagnostic,
  createRegistryToolsVersionNotFoundDiagnostic,
  createRegistryToolsVersionsUnsortedDiagnostic,
} from '#diagnostics/registryTools/RegistryToolsDiagnostics.ts';
// --- Resolver family ---
export type {
  CircularDepDiagnostic,
  PackageNotFoundDiagnostic,
  RegistryNameCollisionDiagnostic,
  ReleaseAgeBlockedDiagnostic,
  ReleaseAgeBlockedData,
  ResolverDiagnostic,
  VersionConflictDiagnostic,
  VersionNotFoundDiagnostic,
} from '#diagnostics/resolver/ResolverDiagnostics.ts';
export {
  createCircularDepDiagnostic,
  createPackageNotFoundDiagnostic,
  createRegistryNameCollisionDiagnostic,
  createReleaseAgeBlockedDiagnostic,
  createVersionConflictDiagnostic,
  createVersionNotFoundDiagnostic,
} from '#diagnostics/resolver/ResolverDiagnostics.ts';
// --- Safety family ---
export type {
  SafetyDiagnostic,
  SafetyOverriddenByForceDiagnostic,
  SafetyPathNotProjectManifestDiagnostic,
  SafetyTargetExistsNoManifestDiagnostic,
} from '#diagnostics/safety/SafetyDiagnostics.ts';
export {
  createSafetyOverriddenByForceDiagnostic,
  createSafetyPathNotProjectManifestDiagnostic,
  createSafetyTargetExistsNoManifestDiagnostic,
} from '#diagnostics/safety/SafetyDiagnostics.ts';
// --- Spec-parse family ---
export type {
  InvalidOrgNameDiagnostic,
  InvalidPackageSpecDiagnostic,
  InvalidVersionRangeDiagnostic,
  SpecParseDiagnostic,
} from '#diagnostics/spec/SpecDiagnostics.ts';
export {
  createInvalidOrgNameDiagnostic,
  createInvalidPackageSpecDiagnostic,
  createInvalidVersionRangeDiagnostic,
} from '#diagnostics/spec/SpecDiagnostics.ts';
// Unified type
export type { Diagnostic, DiagnosticByCode, DiagnosticCode } from '#diagnostics/types.ts';
