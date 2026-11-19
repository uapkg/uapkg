import type { PackageName } from '@uapkg/common-schema';
import type { LockDependency, Lockfile } from '@uapkg/package-manifest-schema';

/**
 * A change to a single package between two lockfile snapshots.
 */
export interface LockfileChange {
  readonly name: PackageName;
  readonly previous?: LockDependency;
  readonly current?: LockDependency;
}

/**
 * Full diff between a previous and a current lockfile.
 */
export interface LockfileDiff {
  readonly added: readonly LockfileChange[];
  readonly updated: readonly LockfileChange[];
  readonly removed: readonly LockfileChange[];
  readonly unchanged: readonly LockfileChange[];
  readonly summary: {
    readonly added: number;
    readonly updated: number;
    readonly removed: number;
    readonly unchanged: number;
  };
}

/**
 * Pure diff of two lockfiles keyed by package name.
 *
 * Two entries are considered "unchanged" iff their
 *   (version, registry, integrity, gitTree, dependencies)
 * tuples are identical. Any other difference produces an "updated" record.
 */
export class LockfileDiffer {
  diff(previous: Lockfile | null, current: Lockfile): LockfileDiff {
    const prev = previous?.packages ?? {};
    const next = current.packages;

    const added: LockfileChange[] = [];
    const updated: LockfileChange[] = [];
    const removed: LockfileChange[] = [];
    const unchanged: LockfileChange[] = [];

    const allNames = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);

    for (const name of allNames) {
      const before = Object.hasOwn(prev, name) ? (prev as Record<string, LockDependency>)[name] : undefined;
      const after = Object.hasOwn(next, name) ? (next as Record<string, LockDependency>)[name] : undefined;

      if (!before && after) {
        added.push({ name: name as PackageName, current: after });
      } else if (before && !after) {
        removed.push({ name: name as PackageName, previous: before });
      } else if (before && after) {
        if (this.isSameEntry(before, after)) {
          unchanged.push({ name: name as PackageName, previous: before, current: after });
        } else {
          updated.push({ name: name as PackageName, previous: before, current: after });
        }
      }
    }

    return {
      added,
      updated,
      removed,
      unchanged,
      summary: {
        added: added.length,
        updated: updated.length,
        removed: removed.length,
        unchanged: unchanged.length,
      },
    };
  }

  private isSameEntry(a: LockDependency, b: LockDependency): boolean {
    if (a.version !== b.version) return false;
    if (a.registry !== b.registry) return false;
    if (a.integrity !== b.integrity) return false;
    if (a.gitTree !== b.gitTree) return false;
    return this.isSameChildMap(a.dependencies, b.dependencies);
  }

  private isSameChildMap(a?: Record<string, string>, b?: Record<string, string>): boolean {
    const ak = a ? Object.keys(a) : [];
    const bk = b ? Object.keys(b) : [];
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if ((a as Record<string, string>)[k] !== (b as Record<string, string>)[k]) return false;
    }
    return true;
  }
}
