import { z } from 'zod';
import { BaseManifestSchema } from '#package-manifest-schema/manifest/BaseManifestSchema.ts';

/**
 * Plugin manifest — `uapkg.json` for a plugin package.
 *
 * Plugins MUST NOT have `overrides`.
 */
export const PluginManifestSchema = BaseManifestSchema.extend({
  kind: z.literal('plugin'),
  uapkgVersion: z.never().optional(),
}).refine((data) => !('overrides' in data && data.overrides !== undefined), {
  message: 'Overrides are not allowed in plugin manifests',
  path: ['overrides'],
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
