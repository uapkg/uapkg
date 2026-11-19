import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeJsonParse, stableStringify } from '@uapkg/common';
import type { PackageName } from '@uapkg/common-schema';
import {
  createIoErrorDiagnostic,
  createManifestReadErrorDiagnostic,
  createManifestWriteErrorDiagnostic,
  createRegistryToolsPackageMissingDiagnostic,
  createSchemaInvalidDiagnostic,
  DiagnosticBag,
  ok,
  type Result,
} from '@uapkg/diagnostics';
import {
  type PackageRegistryManifest,
  PackageRegistryManifestSchema,
  type RegistryVersion,
} from '@uapkg/registry-schema';
import type { RegistryToolsAggregator } from '#registry-tools/aggregator/RegistryToolsAggregator.ts';
import type { WriteManifestResult } from '#registry-tools/contracts/RegistryToolsTypes.ts';
import { sortVersionsNewestFirst } from '#registry-tools/mutation/VersionSorter.ts';
import type { RegistryRepoPaths } from '#registry-tools/paths/RegistryRepoPaths.ts';

/**
 * Reads, validates, and writes registry-package manifests on disk.
 *
 * Responsibilities:
 *  - Resolve manifest paths for a given package name.
 *  - Decode JSON safely.
 *  - Validate against `PackageRegistryManifestSchema`.
 *  - Write deterministic, sorted, pretty-printed JSON.
 */
export class ManifestStore {
  constructor(
    private readonly paths: RegistryRepoPaths,
    private readonly aggregator: RegistryToolsAggregator,
  ) {}

  /** Resolve the manifest path for a package. Pure path computation. */
  resolveManifestPath(packageName: PackageName): string {
    return this.paths.manifestPath(packageName);
  }

  /** True if the manifest file exists on disk. */
  exists(packageName: PackageName): boolean {
    return existsSync(this.paths.manifestPath(packageName));
  }

  /** Read and validate a package manifest. Emits a missing-package diagnostic when absent. */
  async read(packageName: PackageName): Promise<Result<PackageRegistryManifest>> {
    const bag = new DiagnosticBag();
    const filePath = this.paths.manifestPath(packageName);

    if (!existsSync(filePath)) {
      const diag = createRegistryToolsPackageMissingDiagnostic(packageName, filePath);
      bag.add(diag);
      this.aggregator.add(diag);
      return bag.toFailure();
    }

    return this.readFromPath(filePath);
  }

  /** Read and validate a manifest file at an arbitrary path. */
  async readFromPath(filePath: string): Promise<Result<PackageRegistryManifest>> {
    const bag = new DiagnosticBag();

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const diag = createManifestReadErrorDiagnostic(filePath, reason);
      bag.add(diag);
      this.aggregator.add(diag);
      return bag.toFailure();
    }

    const parsed = safeJsonParse<unknown>(raw, filePath);
    if (!parsed.ok) {
      bag.mergeArray(parsed.diagnostics);
      this.aggregator.addMany(parsed.diagnostics);
      return bag.toFailure();
    }

    const result = PackageRegistryManifestSchema.safeParse(parsed.value);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      const diag = createSchemaInvalidDiagnostic(filePath, issues);
      bag.add(diag);
      this.aggregator.add(diag);
      return bag.toFailure();
    }

    return ok(result.data, bag.all());
  }

  /**
   * Write a package manifest deterministically.
   *
   * Versions are pre-sorted newest-first by SemVer. The on-disk JSON uses
   * stable key ordering and a trailing newline so version control shows
   * minimal diffs.
   */
  async write(manifest: PackageRegistryManifest): Promise<Result<WriteManifestResult>> {
    const bag = new DiagnosticBag();
    const filePath = this.paths.manifestPath(manifest.name);

    const validated = PackageRegistryManifestSchema.safeParse(manifest);
    if (!validated.success) {
      const issues = validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
      const diagnostic = createSchemaInvalidDiagnostic(filePath, issues);
      this.aggregator.add(diagnostic);
      return bag.add(diagnostic).toFailure();
    }
    const normalized = this.normalize(manifest);
    const body = `${stableStringify(normalized)}\n`;

    try {
      await mkdir(dirname(filePath), { recursive: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const diag = createIoErrorDiagnostic(dirname(filePath), reason);
      bag.add(diag);
      this.aggregator.add(diag);
      return bag.toFailure();
    }

    try {
      await writeFile(filePath, body, 'utf-8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const diag = createManifestWriteErrorDiagnostic(filePath, reason);
      bag.add(diag);
      this.aggregator.add(diag);
      return bag.toFailure();
    }

    return ok({ manifestPath: filePath, bytesWritten: Buffer.byteLength(body, 'utf-8') }, bag.all());
  }

  /** Sort versions newest-first by SemVer; preserves all other fields. */
  normalize(manifest: PackageRegistryManifest): PackageRegistryManifest {
    const sortedKeys = sortVersionsNewestFirst(Object.keys(manifest.versions));
    const source = manifest.versions as unknown as Record<string, RegistryVersion>;
    const versions: Record<string, RegistryVersion> = {};
    for (const k of sortedKeys) {
      const v = source[k];
      if (v !== undefined) {
        versions[k] = v;
      }
    }
    return {
      name: manifest.name,
      packageSource: manifest.packageSource,
      versions: versions as unknown as PackageRegistryManifest['versions'],
    };
  }
}
