import { CliVersionSelectorSchema } from '@uapkg/common-schema';
import { z } from 'zod';
import { BaseManifestSchema } from '#package-manifest-schema/manifest/BaseManifestSchema.ts';
import { DependencySchema } from '#package-manifest-schema/manifest/DependencySchema.ts';

/**
 * Project manifest — the root `uapkg.json` for a project.
 *
 * Projects MAY specify `overrides` to pin transitive dependency versions.
 */
export const ProjectManifestSchema = BaseManifestSchema.extend({
  kind: z.literal('project'),
  /** CLI version or tracked alias selected by the native launcher for this project. */
  uapkgVersion: CliVersionSelectorSchema.optional(),
  overrides: z.record(z.string(), DependencySchema).optional(),
  dev: z
    .object({
      harness: z.unknown().optional(),
    })
    .optional(),
});

export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;
