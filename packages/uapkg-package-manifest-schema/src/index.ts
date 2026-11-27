// ---------------------------------------------------------------------------
// @uapkg/package-manifest-schema — public API
// ---------------------------------------------------------------------------

// Lockfile schemas
export { type LockDependency, LockDependencySchema } from '#package-manifest-schema/lockfile/LockDependencySchema.ts';
export { type Lockfile, LockfileSchema } from '#package-manifest-schema/lockfile/LockfileSchema.ts';
export { type BaseManifest, BaseManifestSchema } from '#package-manifest-schema/manifest/BaseManifestSchema.ts';
export {
  LifecycleSchema,
  IntegrationEntrySchema,
  CapabilitySchema,
  type Capability,
  type ReleasePermission,
  ReleasePermissionSchema,
} from '#package-manifest-schema/manifest/Lifecycle.ts';
// Manifest schemas
export {
  type Dependency,
  type DependencyDeclaration,
  DependencyDeclarationSchema,
  DependencyLongSchema,
  DependencySchema,
  DependencyShortSchema,
  normalizeDependencyDeclaration,
  normalizeDependencyRecord,
  toDependencyDeclaration,
  toDependencyRecordDeclaration,
} from '#package-manifest-schema/manifest/DependencySchema.ts';
export { type ManifestKind, ManifestKindSchema } from '#package-manifest-schema/manifest/ManifestKind.ts';
export { type Manifest, ManifestSchema } from '#package-manifest-schema/manifest/ManifestSchema.ts';
export { type PluginManifest, PluginManifestSchema } from '#package-manifest-schema/manifest/PluginManifestSchema.ts';
export {
  type ProjectManifest,
  ProjectManifestSchema,
} from '#package-manifest-schema/manifest/ProjectManifestSchema.ts';
export { type Publish, PublishSchema } from '#package-manifest-schema/manifest/PublishSchema.ts';
