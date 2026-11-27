import type { LockDependency, Lockfile } from '@uapkg/package-manifest-schema';
import type { PackageNode, ResolvedGraph } from '#package-manifest/contracts/ManifestTypes.ts';

/**
 * Produces a `Lockfile` from a resolved dependency graph.
 */
export class LockfileSync {
  /** Build a lockfile from the resolved graph. */
  buildLockfile(graph: ResolvedGraph, previous?: Lockfile | null): Lockfile {
    const packages: Record<string, LockDependency> = {};

    for (const node of graph.nodes.values()) {
      const key = node.name;
      packages[key] = this.nodeToLockEntry(node);
    }

    return {
      lockfileVersion: 1,
      ...(previous?.lifecycleRuntimes ? { lifecycleRuntimes: previous.lifecycleRuntimes } : {}),
      packages: packages as Lockfile['packages'],
    };
  }

  private nodeToLockEntry(node: PackageNode): LockDependency {
    const childDeps: Record<string, string> = {};
    for (const [name, child] of node.dependencies) {
      childDeps[name] = child.version;
    }

    return {
      version: node.version,
      registry: node.registry,
      integrity: node.integrity,
      ...(node.gitTree !== undefined ? { gitTree: node.gitTree } : {}),
      dependencies: Object.keys(childDeps).length > 0 ? childDeps : undefined,
    } as LockDependency;
  }
}
