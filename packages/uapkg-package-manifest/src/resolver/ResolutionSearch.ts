import type { Diagnostic, Result } from '@uapkg/diagnostics';
import {
  createCircularDepDiagnostic,
  createRegistryNameCollisionDiagnostic,
  createUnresolvedRegistryDiagnostic,
  createVersionConflictDiagnostic,
  createVersionNotFoundDiagnostic,
  fail,
} from '@uapkg/diagnostics';
import type { LockDependency } from '@uapkg/package-manifest-schema';
import {
  exactDeclaredVersion,
  explicitMinimumVersion,
  releaseAgeEligible,
  SemverSelectionPolicy,
  type PackageRegistryManifest,
  type RegistryCore,
  type RegistryVersion,
} from '@uapkg/registry-core';
import semver from 'semver';
import type { ResolverOptions } from '#package-manifest/contracts/ManifestTypes.ts';

export interface Requirement {
  readonly name: string;
  readonly registry: string;
  readonly range: string;
  readonly root: string;
  readonly newTree: boolean;
  readonly direct: boolean;
  readonly parent?: string;
}

export interface PackageDemand {
  readonly key: string;
  readonly name: string;
  readonly registry: string;
  readonly requirements: readonly Requirement[];
}

export interface SearchSolution {
  readonly assignments: ReadonlyMap<string, string>;
  readonly demands: ReadonlyMap<string, PackageDemand>;
  readonly edges: ReadonlyMap<string, readonly string[]>;
}

interface SearchFailure {
  readonly diagnostics: readonly Diagnostic[];
  readonly involved: ReadonlySet<string>;
}
type SearchOutcome = { readonly solution: SearchSolution } | SearchFailure;

export function versionEntries(manifest: PackageRegistryManifest): Record<string, RegistryVersion> {
  return manifest.versions as Record<string, RegistryVersion>;
}

export function packageIdentity(registry: string, name: string): string {
  return JSON.stringify([registry, name]);
}

/**
 * Chooses one published version of each package for the whole project. If two
 * packages depend on package `mesh`, they must both accept the same version of `mesh`.
 *
 * Suppose the project pins `mesh` to 1.0.0. The search tries version 1.2.0 of
 * package `terrain`, discovers that it requires `mesh` 2.x, and tries the next
 * eligible `terrain` release. If `terrain` 1.1.0 accepts `mesh` 1.x, the two can
 * be installed together. The requirement for `mesh` 2.x applied only to `terrain` 1.2.0.
 *
 * After each choice, the search follows the dependencies of the selected releases
 * again to see which packages need each plugin. If the project turns off the
 * cooldown for new packages, a dependency introduced solely by a new add can
 * use a recent release. A dependency shared with an existing package still
 * follows the minimum release age policy.
 */
export class ResolutionSearch {
  private readonly policy = new SemverSelectionPolicy();
  private readonly manifests = new Map<string, Promise<Result<PackageRegistryManifest>>>();
  private readonly previous = new Map<string, LockDependency>();
  private readonly potentialDependencies = new Map<string, ReadonlySet<string> | null>();
  private readonly candidateCache = new Map<string, readonly string[]>();
  private readonly targetedRoots: ReadonlySet<string>;
  private readonly directIdentities: ReadonlySet<string>;
  public rejectedForAge = false;
  public exploredStates = 0;
  public repairBudget = Number.POSITIVE_INFINITY;

  constructor(
    private readonly registryCore: RegistryCore,
    readonly roots: readonly Requirement[],
    private readonly options: ResolverOptions,
    private readonly minimumAgeMs: number,
    private readonly nowMs: number,
  ) {
    for (const [name, entry] of Object.entries(options.previousLockfile?.packages ?? {})) {
      this.previous.set(packageIdentity(entry.registry, name), entry);
    }
    this.targetedRoots = new Set(
      options.updateTargets?.length === 0 ? roots.map((root) => root.root) : options.updateTargets,
    );
    this.directIdentities = new Set(roots.map((root) => packageIdentity(root.registry, root.name)));
  }

  async solve(ignoreAge: boolean, lockOnly = false, maximumCompatibleDowngrades = 0): Promise<SearchOutcome> {
    const failed = new Map<string, SearchFailure>();
    const search = async (assignments: ReadonlyMap<string, string>): Promise<SearchOutcome> => {
      this.exploredStates++;
      const closure = await this.closure(assignments);
      if ('diagnostics' in closure) return closure;
      const state = JSON.stringify(
        [...closure.demands.keys()].sort().map((key) => [key, assignments.get(key) ?? null]),
      );
      const remembered = failed.get(state);
      if (remembered) return remembered;
      const demands = [...closure.demands.values()].sort((left, right) => {
        return this.priority(left) - this.priority(right) || left.key.localeCompare(right.key, 'en');
      });
      let unresolved: { demand: PackageDemand; candidates: readonly string[] } | undefined;
      for (const demand of demands) {
        const manifest = await this.getManifest(demand);
        if (!manifest.ok) return { diagnostics: manifest.diagnostics, involved: this.parents(demand, closure.demands) };
        const candidates = this.candidates(demand, manifest.value, ignoreAge, lockOnly);
        const assigned = assignments.get(demand.key);
        if (candidates.length === 0 || (assigned !== undefined && !candidates.includes(assigned))) {
          const failure = {
            diagnostics: [this.conflict(demand, manifest.value)],
            involved: this.parents(demand, closure.demands),
          };
          failed.set(state, failure);
          return failure;
        }
        if (assigned === undefined && !unresolved) unresolved = { demand, candidates };
      }
      if (!unresolved) {
        const downgraded: PackageDemand[] = [];
        for (const demand of demands) {
          const locked = this.previous.get(demand.key)?.version;
          const selected = assignments.get(demand.key)!;
          if (locked === undefined || !semver.lt(selected, locked)) continue;
          const manifest = await this.getManifest(demand);
          if (manifest.ok && Object.hasOwn(versionEntries(manifest.value), locked) && this.matches(demand, locked)) {
            downgraded.push(demand);
          }
        }
        if (downgraded.length > maximumCompatibleDowngrades) {
          // All version requirements can be met with these downgrades. Record how
          // many so the resolver can look for a solution that needs fewer.
          this.repairBudget = Math.min(this.repairBudget, downgraded.length);
          const involved = new Set<string>();
          for (const demand of downgraded) for (const key of this.parents(demand, closure.demands)) involved.add(key);
          const first = downgraded[0]!;
          return {
            diagnostics: [
              createVersionConflictDiagnostic(
                first.name,
                [assignments.get(first.key)!, this.previous.get(first.key)!.version],
                first.registry,
              ),
            ],
            involved,
          };
        }
        return { solution: { assignments, demands: closure.demands, edges: closure.edges } };
      }
      let firstFailure: readonly Diagnostic[] | undefined;
      const involved = new Set<string>();
      for (const version of unresolved.candidates) {
        const next = new Map(assignments);
        next.set(unresolved.demand.key, version);
        const outcome = await search(next);
        if ('solution' in outcome) return outcome;
        firstFailure ??= outcome.diagnostics;
        // If changing this package's version cannot affect the conflict, return
        // to the package choice that introduced it.
        if (
          !outcome.involved.has(unresolved.demand.key) &&
          !(await this.canAffect(unresolved.demand, outcome.involved))
        )
          return outcome;
        for (const key of outcome.involved) if (key !== unresolved.demand.key) involved.add(key);
      }
      for (const key of this.parents(unresolved.demand, closure.demands))
        if (key !== unresolved.demand.key) involved.add(key);
      const failure = { diagnostics: firstFailure ?? [this.conflict(unresolved.demand)], involved };
      failed.set(state, failure);
      return failure;
    };
    return search(new Map());
  }

  async getManifest(
    demand: Pick<PackageDemand, 'key' | 'name' | 'registry'>,
  ): Promise<Result<PackageRegistryManifest>> {
    const existing = this.manifests.get(demand.key);
    if (existing) return existing;
    const registry = this.registryCore.getOrCreateRegistry(demand.registry);
    const result = registry.ok
      ? registry.value.getPackageManifest(demand.name, demand.registry)
      : Promise.resolve(fail([createUnresolvedRegistryDiagnostic(demand.registry, demand.name)]));
    this.manifests.set(demand.key, result);
    return result;
  }

  ageAllowed(demand: PackageDemand, version: string, entry: RegistryVersion): boolean {
    if (this.options.ignoreReleaseAge || this.minimumAgeMs === 0 || this.options.frozen) return true;
    if (this.previous.get(demand.key)?.version === version) return true;
    if (this.requiredVersion(demand) === version) return true;
    if (
      demand.requirements.some(
        (requirement) => requirement.direct && exactDeclaredVersion(requirement.range) === version,
      )
    )
      return true;
    if (
      demand.requirements.some(
        (requirement) => requirement.direct && explicitMinimumVersion(requirement.range) === version,
      )
    )
      return true;
    if (
      this.options.applyReleaseAgeToNewPackages === false &&
      !this.previous.has(demand.key) &&
      demand.requirements.every((requirement) => requirement.newTree)
    )
      return true;
    return releaseAgeEligible(entry.meta.publishedAt, this.minimumAgeMs, this.nowMs);
  }

  async blockedReleases(demand: PackageDemand): Promise<readonly { version: string; publishedAt: number }[]> {
    const manifest = await this.getManifest(demand);
    if (!manifest.ok) return [];
    return this.candidates(demand, manifest.value, true, false)
      .filter(
        (version) =>
          this.matches(demand, version) && !this.ageAllowed(demand, version, versionEntries(manifest.value)[version]!),
      )
      .map((version) => ({ version, publishedAt: versionEntries(manifest.value)[version]!.meta.publishedAt }));
  }

  private requiredVersion(demand: PackageDemand): string | undefined {
    return demand.requirements.some((requirement) => requirement.direct) &&
      this.options.requiredVersions !== undefined &&
      Object.hasOwn(this.options.requiredVersions, demand.name)
      ? this.options.requiredVersions[demand.name]
      : undefined;
  }

  private matches(demand: PackageDemand, version: string): boolean {
    const required = this.requiredVersion(demand);
    return (
      (required === undefined || version === required) &&
      demand.requirements.every((requirement) => {
        const exact = exactDeclaredVersion(requirement.range);
        return exact === undefined ? this.policy.matches(version, requirement.range) : version === exact;
      })
    );
  }

  private candidates(
    demand: PackageDemand,
    manifest: PackageRegistryManifest,
    ignoreAge: boolean,
    lockOnly: boolean,
  ): readonly string[] {
    const requirements = [
      ...new Set(
        demand.requirements.map((requirement) =>
          JSON.stringify([requirement.range, requirement.root, requirement.newTree, requirement.direct]),
        ),
      ),
    ].sort();
    const key = JSON.stringify([demand.key, requirements, ignoreAge, lockOnly]);
    const cached = this.candidateCache.get(key);
    if (cached) return cached;
    const candidates = this.computeCandidates(demand, manifest, ignoreAge, lockOnly);
    this.candidateCache.set(key, candidates);
    return candidates;
  }

  private computeCandidates(
    demand: PackageDemand,
    manifest: PackageRegistryManifest,
    ignoreAge: boolean,
    lockOnly: boolean,
  ): string[] {
    const locked = this.previous.get(demand.key)?.version;
    const ranges = demand.requirements.map((requirement) => requirement.range);
    const matches = (version: string): boolean => this.matches(demand, version);
    if (this.options.frozen || lockOnly)
      return locked !== undefined && Object.hasOwn(versionEntries(manifest), locked) && matches(locked) ? [locked] : [];
    let candidates = this.policy.rankCandidates(Object.keys(manifest.versions), ranges, locked).filter(matches);
    const compatibleLock = locked !== undefined && candidates.includes(locked);
    // Try older versions last. A package selected later may require an older
    // version even though the locked version fits the ranges seen so far.
    if (compatibleLock)
      candidates = [
        ...candidates.filter((version) => !semver.lt(version, locked)),
        ...candidates.filter((version) => semver.lt(version, locked)),
      ];
    if (!ignoreAge) {
      candidates = candidates.filter((version) => {
        const eligible = this.ageAllowed(demand, version, versionEntries(manifest)[version]!);
        if (!eligible) this.rejectedForAge = true;
        return eligible;
      });
    }
    const updating =
      this.options.updateTargets !== undefined &&
      demand.requirements.some(
        (requirement) =>
          this.targetedRoots.has(requirement.root) &&
          (requirement.direct || this.options.recursive || this.options.updateTargets?.length === 0),
      );
    if (compatibleLock && !updating) candidates = [locked, ...candidates.filter((version) => version !== locked)];
    return candidates;
  }

  private async closure(assignments: ReadonlyMap<string, string>): Promise<
    | {
        demands: ReadonlyMap<string, PackageDemand>;
        edges: ReadonlyMap<string, readonly string[]>;
      }
    | SearchFailure
  > {
    const demands = new Map<string, PackageDemand>();
    const requirements = new Map<string, Map<string, Requirement>>();
    const edges = new Map<string, Set<string>>();
    const expanded = new Set<string>();
    const queue = [...this.roots];
    for (let index = 0; index < queue.length; index++) {
      const requirement = queue[index]!;
      const key = packageIdentity(requirement.registry, requirement.name);
      const contribution = JSON.stringify([
        requirement.root,
        requirement.parent,
        requirement.range,
        requirement.direct,
        requirement.newTree,
      ]);
      const incoming = requirements.get(key) ?? new Map<string, Requirement>();
      if (incoming.has(contribution)) continue;
      incoming.set(contribution, requirement);
      requirements.set(key, incoming);
      const demand = {
        key,
        name: requirement.name,
        registry: requirement.registry,
        requirements: [...incoming.values()],
      };
      demands.set(key, demand);
      if (requirement.parent) {
        const children = edges.get(requirement.parent) ?? new Set<string>();
        children.add(key);
        edges.set(requirement.parent, children);
      }
      const version = assignments.get(key);
      if (!version) continue;
      const newTree = requirement.newTree && !this.previous.has(key);
      const expansion = JSON.stringify([key, requirement.root, newTree]);
      if (expanded.has(expansion)) continue;
      expanded.add(expansion);
      const manifest = await this.getManifest(demand);
      if (!manifest.ok) return { diagnostics: manifest.diagnostics, involved: this.parents(demand, demands) };
      const entry = versionEntries(manifest.value)[version];
      if (!entry)
        return { diagnostics: [this.conflict(demand, manifest.value)], involved: this.parents(demand, demands) };
      for (const [name, dep] of Object.entries(entry.dependencies ?? {}).sort(([left], [right]) =>
        left.localeCompare(right, 'en'),
      )) {
        queue.push({
          name,
          registry: dep.registry ?? requirement.registry,
          range: dep.version,
          root: requirement.root,
          newTree,
          direct: false,
          parent: key,
        });
      }
    }
    const registries = new Map<string, Set<string>>();
    for (const demand of demands.values()) {
      const aliases = registries.get(demand.name) ?? new Set<string>();
      aliases.add(demand.registry);
      registries.set(demand.name, aliases);
      if (aliases.size > 1) {
        const involved = new Set<string>();
        for (const other of demands.values())
          if (other.name === demand.name) {
            for (const key of this.parents(other, demands)) involved.add(key);
          }
        return { diagnostics: [createRegistryNameCollisionDiagnostic(demand.name, [...aliases].sort())], involved };
      }
    }
    const complete = new Set<string>();
    const visit = (key: string, stack: readonly string[]): readonly string[] | undefined => {
      const index = stack.indexOf(key);
      if (index !== -1) return [...stack.slice(index), key];
      if (complete.has(key)) return undefined;
      for (const child of edges.get(key) ?? []) {
        const cycle = visit(child, [...stack, key]);
        if (cycle) return cycle;
      }
      complete.add(key);
      return undefined;
    };
    for (const key of demands.keys()) {
      const cycle = visit(key, []);
      if (cycle) {
        const involved = new Set<string>();
        for (const key of cycle)
          for (const ancestor of this.parents(demands.get(key)!, demands)) involved.add(ancestor);
        return {
          diagnostics: [createCircularDepDiagnostic(cycle.map((identity) => demands.get(identity)!.name))],
          involved,
        };
      }
    }
    return { demands, edges: new Map([...edges].map(([key, children]) => [key, [...children].sort()])) };
  }

  private priority(demand: PackageDemand): number {
    const targeted = demand.requirements.some((requirement) => this.targetedRoots.has(requirement.root));
    const directTarget = demand.requirements.some(
      (requirement) => requirement.direct && this.targetedRoots.has(requirement.root),
    );
    if (directTarget) return 0;
    if (targeted && (this.options.recursive || this.options.updateTargets?.length === 0)) return 1;
    return this.directIdentities.has(demand.key) ? 2 : 3;
  }

  private parents(demand: PackageDemand, demands: ReadonlyMap<string, PackageDemand>): ReadonlySet<string> {
    const involved = new Set<string>();
    const queue = [demand.key];
    for (let index = 0; index < queue.length; index++) {
      const key = queue[index]!;
      if (involved.has(key)) continue;
      involved.add(key);
      for (const requirement of demands.get(key)?.requirements ?? []) {
        if (requirement.parent !== undefined) queue.push(requirement.parent);
      }
    }
    return involved;
  }

  private async canAffect(demand: PackageDemand, involved: ReadonlySet<string>): Promise<boolean> {
    // A different release can introduce a dependency involved in the conflict.
    // Check the cached dependencies of every release before skipping alternatives.
    // If any registry metadata is missing, keep trying versions.
    let potential = this.potentialDependencies.get(demand.key);
    if (potential === undefined) {
      const reachable = new Set<string>();
      const queue: Pick<PackageDemand, 'key' | 'name' | 'registry'>[] = [demand];
      let unknown = false;
      for (let index = 0; index < queue.length; index++) {
        const current = queue[index]!;
        if (reachable.has(current.key)) continue;
        reachable.add(current.key);
        const cached = this.manifests.get(current.key);
        if (!cached) {
          unknown = true;
          break;
        }
        const manifest = await cached;
        if (!manifest.ok) {
          unknown = true;
          break;
        }
        for (const entry of Object.values(versionEntries(manifest.value))) {
          for (const [name, dep] of Object.entries(entry.dependencies ?? {})) {
            const registry = dep.registry ?? current.registry;
            queue.push({ key: packageIdentity(registry, name), registry, name });
          }
        }
      }
      potential = unknown ? null : reachable;
      this.potentialDependencies.set(demand.key, potential);
    }
    if (potential === null) return true;
    const names = new Set([...involved].map((key) => (JSON.parse(key) as [string, string])[1]));
    return [...potential].some((key) => involved.has(key) || names.has((JSON.parse(key) as [string, string])[1]));
  }

  private conflict(demand?: PackageDemand, manifest?: PackageRegistryManifest): Diagnostic {
    if (!demand) return createVersionNotFoundDiagnostic('(graph)', '*', '(unknown)', []);
    const ranges = [...new Set(demand.requirements.map((requirement) => requirement.range))];
    const versions = manifest ? Object.keys(manifest.versions) : [];
    if (
      ranges.length > 1 &&
      versions.length > 0 &&
      ranges.every((range) => this.policy.rankCandidates(versions, [range]).length > 0)
    ) {
      return createVersionConflictDiagnostic(
        demand.name,
        [...new Set(ranges.map((range) => this.policy.rankCandidates(versions, [range])[0]!))],
        demand.registry,
      );
    }
    return createVersionNotFoundDiagnostic(demand.name, ranges.join(' & '), demand.registry, versions);
  }
}
