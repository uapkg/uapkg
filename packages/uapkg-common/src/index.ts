// ---------------------------------------------------------------------------
// @uapkg/common — public API
// ---------------------------------------------------------------------------

// Human formatting
export { prettyBytes, prettyBytesProgress } from '#common/format/prettyBytes.ts';
export {
  computeRegistryIdentifier,
  computeRegistryIdentifierShort,
  type RegistryIdentityDescriptor,
} from '#common/hash/registryIdentifier.ts';
// Hashing
export { sha256, sha256Prefixed } from '#common/hash/sha256.ts';
export { safeJsonParse } from '#common/json/safeJsonParse.ts';
export {
  DEFAULT_PACKAGE_MINIMUM_RELEASE_AGE,
  parseReleaseAgeMilliseconds,
} from '#common/time/parseReleaseAgeMilliseconds.ts';
// JSON
export { stableStringify } from '#common/json/stableStringify.ts';
// Normalization
export { normalizeUrl } from '#common/normalize/normalizeUrl.ts';
// Paths
export { normalizePath, toForwardSlash } from '#common/paths/forwardSlash.ts';
// Runtime profile
export {
  INTERNAL_BUILD_MODE_ENV,
  INTERNAL_PROFILE_HOME_ENV,
  resolveActiveUapkgProfileRoot,
  resolveUapkgBuildMode,
  resolveUapkgProfileRoot,
  type UAPKGBuildMode,
} from '#common/runtime/UapkgRuntimeProfile.ts';
// Package spec parsing (CLI "@org/name@range")
export { formatPackageSpec, parsePackageSpec } from '#common/spec/parsePackageSpec.ts';
