// ---------------------------------------------------------------------------
// @uapkg/common-schema — public API
// ---------------------------------------------------------------------------

// Brand utility
export type { Brand } from '#common-schema/brand/Brand.ts';
export type { CliVersionSelector } from '#common-schema/primitives/CliVersionSelector.ts';
export { CliVersionSelectorSchema } from '#common-schema/primitives/CliVersionSelector.ts';
export type { AssetHash } from '#common-schema/primitives/AssetHash.ts';
export { AssetHashSchema } from '#common-schema/primitives/AssetHash.ts';
export type { ConcurrencyCount } from '#common-schema/primitives/ConcurrencyCount.ts';
export { ConcurrencyCountSchema } from '#common-schema/primitives/ConcurrencyCount.ts';
export type { DurationSeconds } from '#common-schema/primitives/DurationSeconds.ts';
export { DurationSecondsSchema } from '#common-schema/primitives/DurationSeconds.ts';
export type { DurationString } from '#common-schema/primitives/DurationString.ts';
export { DurationStringSchema } from '#common-schema/primitives/DurationString.ts';
export type { GitTree } from '#common-schema/primitives/GitTree.ts';
export { GitTreeSchema } from '#common-schema/primitives/GitTree.ts';
export type { InstallPath } from '#common-schema/primitives/InstallPath.ts';
export { InstallPathSchema } from '#common-schema/primitives/InstallPath.ts';
// Added in Phase 0 (commands/installer/postinstall work)
export type { OrgName } from '#common-schema/primitives/OrgName.ts';
export { OrgNameSchema } from '#common-schema/primitives/OrgName.ts';
// Branded primitives — types
export type { PackageName } from '#common-schema/primitives/PackageName.ts';
// Branded primitives — Zod schemas
export { isScopedPackageName, PackageNameSchema } from '#common-schema/primitives/PackageName.ts';
export type { PackageSpec } from '#common-schema/primitives/PackageSpec.ts';
export { PackageSpecSchema } from '#common-schema/primitives/PackageSpec.ts';
export type { PackageVersion } from '#common-schema/primitives/PackageVersion.ts';
export { PackageVersionSchema } from '#common-schema/primitives/PackageVersion.ts';
export type { RegistryIdentifier, RegistryIdentifierShort } from '#common-schema/primitives/RegistryIdentifier.ts';
export {
  RegistryIdentifierSchema,
  RegistryIdentifierShortSchema,
} from '#common-schema/primitives/RegistryIdentifier.ts';
export type { RegistryName } from '#common-schema/primitives/RegistryName.ts';
export { DEFAULT_REGISTRY_ALIAS, RegistryNameSchema } from '#common-schema/primitives/RegistryName.ts';
export type { RegistryURL } from '#common-schema/primitives/RegistryURL.ts';
export { RegistryURLSchema } from '#common-schema/primitives/RegistryURL.ts';
export type { UnixTimestamp } from '#common-schema/primitives/UnixTimestamp.ts';
export { UnixTimestampSchema } from '#common-schema/primitives/UnixTimestamp.ts';
export type { VersionRange } from '#common-schema/primitives/VersionRange.ts';
export { VersionRangeSchema } from '#common-schema/primitives/VersionRange.ts';
