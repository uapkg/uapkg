import { PackageNameSchema, PackageVersionSchema } from '@uapkg/common-schema';
import { z } from 'zod';
import { DependencySchema } from '#package-manifest-schema/manifest/DependencySchema.ts';
import {
  IntegrationEntrySchema,
  LifecycleSchema,
  PermissionsSchema,
} from '#package-manifest-schema/manifest/Lifecycle.ts';
import { ManifestKindSchema } from '#package-manifest-schema/manifest/ManifestKind.ts';
import { PublishSchema } from '#package-manifest-schema/manifest/PublishSchema.ts';

/**
 * Fields shared by all manifest kinds.
 *
 * Loose: unknown top-level members are preserved so read-modify-write
 * commands do not strip fields this build does not understand, and newer
 * optional manifest fields never fail an older client.
 */
export const BaseManifestSchema = z.looseObject({
  name: PackageNameSchema,
  version: PackageVersionSchema,
  kind: ManifestKindSchema,
  permissions: PermissionsSchema.optional(),
  integration: IntegrationEntrySchema.optional(),
  lifecycle: LifecycleSchema.optional(),
  private: z.boolean().optional(),
  publish: PublishSchema.optional(),
  dependencies: z.record(z.string(), DependencySchema).optional(),
  devDependencies: z.record(z.string(), DependencySchema).optional(),
  peerDependencies: z.record(z.string(), DependencySchema).optional(),
});

export type BaseManifest = z.infer<typeof BaseManifestSchema>;
