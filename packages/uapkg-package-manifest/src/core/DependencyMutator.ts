import {
  type Dependency,
  type Manifest,
  type ProjectManifest,
  normalizeDependencyDeclaration,
} from '@uapkg/package-manifest-schema';

/**
 * Which dependency bucket a mutation targets.
 */
export type DependencyBucket = 'dependencies' | 'devDependencies' | 'peerDependencies';

/**
 * Options controlling `addDependency`.
 */
export interface AddDependencyOptions {
  readonly bucket?: DependencyBucket;
  /**
   * When true AND the manifest is a project, the dependency is also written
   * to `overrides`, pinning the exact version across the tree.
   */
  readonly pin?: boolean;
}

export interface RemoveDependencyResult {
  readonly manifest: Manifest;
  readonly removed: boolean;
}

/**
 * Pure, immutable mutations of a `Manifest`.
 *
 * Responsibilities:
 *  - Return a *new* `Manifest` value; never mutate the input.
 *  - Know nothing about IO — `PackageManifest` composes with `ManifestWriter`.
 *
 * All inputs are already Zod-validated by callers (reader layer).
 */
export class DependencyMutator {
  /**
   * Add or replace a dependency. When `options.pin` and the manifest is a
   * project, the same entry is mirrored into `overrides`.
   */
  addDependency(manifest: Manifest, name: string, dep: Dependency, options: AddDependencyOptions = {}): Manifest {
    const declaration = normalizeDependencyDeclaration(dep);
    const bucket: DependencyBucket = options.bucket ?? 'dependencies';
    const next: Manifest = {
      ...manifest,
      [bucket]: { ...manifest[bucket], [name]: declaration },
    } as Manifest;

    if (options.pin && next.kind === 'project') {
      const project = next as ProjectManifest;
      return {
        ...project,
        overrides: { ...project.overrides, [name]: declaration },
      } as Manifest;
    }

    return next;
  }

  /**
   * Remove a dependency from every bucket. If the manifest is a project, the
   * matching `overrides` entry (if any) is also removed.
   */
  removeDependency(manifest: Manifest, name: string): RemoveDependencyResult {
    let removed = false;

    const stripFromBucket = (bucket: DependencyBucket) => {
      const existing = manifest[bucket];
      if (!existing || !Object.hasOwn(existing, name)) return existing;
      const { [name]: _removed, ...rest } = existing;
      removed = true;
      return Object.keys(rest).length === 0 ? undefined : rest;
    };

    const next: Manifest = {
      ...manifest,
      dependencies: stripFromBucket('dependencies'),
      devDependencies: stripFromBucket('devDependencies'),
      peerDependencies: stripFromBucket('peerDependencies'),
    } as Manifest;

    if (next.kind === 'project') {
      const project = next as ProjectManifest;
      if (project.overrides && Object.hasOwn(project.overrides, name)) {
        const { [name]: _overridden, ...restOverrides } = project.overrides;
        removed = true;
        return {
          manifest: {
            ...project,
            overrides: Object.keys(restOverrides).length === 0 ? undefined : restOverrides,
          } as Manifest,
          removed,
        };
      }
    }

    return { manifest: next, removed };
  }

  /**
   * Set or clear an override pin on a project manifest. No-op on plugin manifests.
   */
  setPin(manifest: Manifest, name: string, dep: Dependency | null): Manifest {
    if (manifest.kind !== 'project') return manifest;
    const project = manifest as ProjectManifest;
    if (dep === null) {
      if (!project.overrides || !Object.hasOwn(project.overrides, name)) return manifest;
      const { [name]: _removed, ...rest } = project.overrides;
      return {
        ...project,
        overrides: Object.keys(rest).length === 0 ? undefined : rest,
      } as Manifest;
    }

    const declaration = normalizeDependencyDeclaration(dep);
    return {
      ...project,
      overrides: { ...project.overrides, [name]: declaration },
    } as Manifest;
  }
}
