import { PackageNameSchema } from '@uapkg/common-schema';
import { z } from 'zod';
import { LockDependencySchema } from '#package-manifest-schema/lockfile/LockDependencySchema.ts';

/** Lockfile versions this build understands. Unknown versions fail closed. */
export const SUPPORTED_LOCKFILE_VERSIONS = [1] as const;

/**
 * Schema for `uapkg.lock`. `lockfileVersion` dispatches exact supported
 * values; an unrecognized version means the lockfile was written by a newer
 * client and must not be reinterpreted.
 */
export const LockfileSchema = z.object({
  lockfileVersion: z.literal(SUPPORTED_LOCKFILE_VERSIONS),
  packages: z.record(PackageNameSchema, LockDependencySchema),
  lifecycleRuntimes: z
    .object({
      node: z
        .record(
          z.string().regex(/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))?$/),
          z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/),
        )
        .refine(
          (pins) =>
            Object.entries(pins).every(([selector, version]) =>
              selector.includes('.') ? selector === version : selector === version.split('.')[0],
            ),
          'Node pin must satisfy its selector',
        ),
    })
    .strict()
    .optional(),
});

export type Lockfile = z.infer<typeof LockfileSchema>;
