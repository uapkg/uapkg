import {
  AssetHashSchema,
  PackageNameSchema,
  PackageVersionSchema,
  RegistryIdentifierSchema,
  RegistryNameSchema,
} from '@uapkg/common-schema';
import { z } from 'zod';

export const CapabilitySchema = z.enum(['integration', 'postinstall']);
export type Capability = z.infer<typeof CapabilitySchema>;

export const ReleasePermissionSchema = z.strictObject({
  registry: RegistryNameSchema,
  registryId: RegistryIdentifierSchema,
  packageName: PackageNameSchema,
  version: PackageVersionSchema,
  integrity: AssetHashSchema,
  capabilities: z.array(CapabilitySchema),
});
export type ReleasePermission = z.infer<typeof ReleasePermissionSchema>;

export const PermissionsSchema = z.strictObject({ releases: z.array(ReleasePermissionSchema) });
export const IntegrationEntrySchema = z.strictObject({ entry: z.string().min(1).optional() });
export const LifecycleSchema = z.strictObject({
  scripts: z
    .strictObject({ prepack: z.string().min(1).optional(), postinstall: z.string().min(1).optional() })
    .optional(),
  runtime: z
    .strictObject({ node: z.string().regex(/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))?$/) })
    .optional(),
});
