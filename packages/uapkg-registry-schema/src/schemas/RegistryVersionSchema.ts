import { GitTreeSchema, PackageNameSchema, UnixTimestampSchema } from '@uapkg/common-schema';
import { z } from 'zod';
import { RegistryAssetSchema } from '#registry-schema/schemas/RegistryAssetSchema.ts';
import { RegistryDependencySchema } from '#registry-schema/schemas/RegistryDependencySchema.ts';

/**
 * Release files attached to a version.
 */
export const ReleaseFilesSchema = z.object({
  package: RegistryAssetSchema,
});

/**
 * Metadata about a published version.
 */
export const VersionMetaSchema = z.object({
  publishedAt: UnixTimestampSchema,
});

/**
 * A single version entry within a package registry manifest.
 *
 * Unknown optional members are tolerated (and ignored) rather than rejected:
 * install-time verification compares the mandatory core plus the optional
 * keys understood on both sides, so a newer record must not break an older
 * client. The mandatory core itself stays strictly validated.
 */
export const RegistryVersionSchema = z.object({
  // Required by public-registry policy, but structurally optional so trusted
  // private registries can publish records without a public Git tree.
  gitTree: GitTreeSchema.optional(),
  // Normalized packaged `private` claim; records predating the field read as false.
  private: z.boolean().default(false),
  meta: VersionMetaSchema,
  releaseFiles: ReleaseFilesSchema,
  dependencies: z.record(PackageNameSchema, RegistryDependencySchema).optional(),
  devDependencies: z.record(PackageNameSchema, RegistryDependencySchema).optional(),
  peerDependencies: z.record(PackageNameSchema, RegistryDependencySchema).optional(),
});

export type RegistryVersion = z.infer<typeof RegistryVersionSchema>;
export type ReleaseFiles = z.infer<typeof ReleaseFilesSchema>;
export type VersionMeta = z.infer<typeof VersionMetaSchema>;
