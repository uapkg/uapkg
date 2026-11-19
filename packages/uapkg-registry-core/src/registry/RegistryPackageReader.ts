import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeJsonParse } from '@uapkg/common';
import {
  createPackageNotFoundDiagnostic,
  createSchemaInvalidDiagnostic,
  DiagnosticBag,
  ok,
  type Result,
} from '@uapkg/diagnostics';
import {
  createPackageRegistryManifestSchema,
  getRegistryPackagePathSegments,
  type PackageRegistryManifest,
  PackageRegistryManifestSchema,
  RegistryMetaSchema,
} from '@uapkg/registry-schema';
import { getRegistryRepoPath } from '#registry-core/paths/RegistryPaths.ts';

/**
 * Reads package manifests from the local cloned registry repo.
 *
 * Layout: `packages/{first-letter}/{package-name}.json` (unscoped) or
 * `packages/@{scope}/{package-name}.json` (scoped).
 */
export class RegistryPackageReader {
  constructor(private readonly shortId: string) {}

  /** Read and validate a package registry manifest. */
  async readPackageManifest(packageName: string, registryName?: string): Promise<Result<PackageRegistryManifest>> {
    const bag = new DiagnosticBag();
    const filePath = this.resolveManifestPath(packageName);

    if (!existsSync(filePath)) {
      bag.add(createPackageNotFoundDiagnostic(packageName, registryName));
      return bag.toFailure();
    }

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (err) {
      bag.addError('CACHE_READ_ERROR', `Failed to read ${filePath}: ${String(err)}`, {
        cachePath: filePath,
        reason: String(err),
      });
      return bag.toFailure();
    }

    const parseResult = safeJsonParse<unknown>(raw, filePath);
    if (!parseResult.ok) {
      bag.mergeArray(parseResult.diagnostics);
      return bag.toFailure();
    }

    const registryType = await this.readRegistryType(bag);
    if (bag.hasErrors()) return bag.toFailure();
    const manifestSchema = registryType
      ? createPackageRegistryManifestSchema(registryType)
      : PackageRegistryManifestSchema;
    const validated = manifestSchema.safeParse(parseResult.value);
    if (!validated.success) {
      const issues = validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      bag.add(createSchemaInvalidDiagnostic(filePath, issues));
      return bag.toFailure();
    }

    return ok(validated.data);
  }

  private resolveManifestPath(packageName: string): string {
    return join(getRegistryRepoPath(this.shortId), ...getRegistryPackagePathSegments(packageName));
  }

  /**
   * Read the trusted context for registry-type-dependent package validation.
   * Missing, invalid, and unsupported metadata all fail closed: registry type
   * is required to select the correct package-record policy.
   */
  private async readRegistryType(bag: DiagnosticBag): Promise<'public' | 'private' | undefined> {
    const metaPath = join(getRegistryRepoPath(this.shortId), '.uapkg', 'registry.meta.json');
    if (!existsSync(metaPath)) {
      bag.add(createSchemaInvalidDiagnostic(metaPath, ['Required registry metadata file is missing.']));
      return undefined;
    }

    let raw: string;
    try {
      raw = await readFile(metaPath, 'utf-8');
    } catch (error) {
      bag.addError('CACHE_READ_ERROR', `Failed to read ${metaPath}: ${String(error)}`, {
        cachePath: metaPath,
        reason: String(error),
      });
      return undefined;
    }

    const parseResult = safeJsonParse<unknown>(raw, metaPath);
    if (!parseResult.ok) {
      bag.mergeArray(parseResult.diagnostics);
      return undefined;
    }
    const validated = RegistryMetaSchema.safeParse(parseResult.value);
    if (!validated.success) {
      const issues = validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
      bag.add(createSchemaInvalidDiagnostic(metaPath, issues));
      return undefined;
    }
    return validated.data.registry.registryType;
  }
}
