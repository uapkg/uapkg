import fs from 'node:fs';
import path from 'node:path';
import {
  createManifestInvalidDiagnostic,
  createManifestReadErrorDiagnostic,
  fail,
  ok,
  type Result,
} from '@uapkg/diagnostics';
import semver from 'semver';
import { IntegrationEntrySchema, LifecycleSchema } from '@uapkg/package-manifest-schema';
import { z } from 'zod';
import type { PackManifest } from '#pack/contracts/PackTypes.ts';

const packManifestSchema = z.object({
  integration: IntegrationEntrySchema.optional(),
  lifecycle: LifecycleSchema.optional(),
  dependencies: z.record(z.string(), z.unknown()).optional(),
  devDependencies: z.record(z.string(), z.unknown()).optional(),
  peerDependencies: z.record(z.string(), z.unknown()).optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
  name: z.string().min(1),
  version: z
    .string()
    .min(1)
    .refine((v) => semver.valid(semver.clean(v)) !== null, {
      message: 'Invalid semver version',
    }),
});

export class PackManifestReader {
  read(pluginRoot: string): Result<PackManifest> {
    const manifestPath = path.join(pluginRoot, 'uapkg.json');

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      return fail([createManifestReadErrorDiagnostic(manifestPath, details)]);
    }

    const validated = packManifestSchema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      return fail([createManifestInvalidDiagnostic(manifestPath, issues)]);
    }

    return ok(validated.data);
  }
}
