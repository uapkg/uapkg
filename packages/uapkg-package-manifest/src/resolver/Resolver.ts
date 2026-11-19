import { DEFAULT_PACKAGE_MINIMUM_RELEASE_AGE, parseReleaseAgeMilliseconds } from '@uapkg/common';
import { DEFAULT_REGISTRY_ALIAS } from '@uapkg/common-schema';
import {
  createDiagnostic,
  createReleaseAgeBlockedDiagnostic,
  fail,
  ok,
  type Diagnostic,
  type Result,
} from '@uapkg/diagnostics';
import type { Dependency, Manifest } from '@uapkg/package-manifest-schema';
import { releaseAgeRemainingSeconds, SemverSelectionPolicy, type RegistryCore } from '@uapkg/registry-core';
import semver from 'semver';
import type {
  HeldBackRelease,
  PackageNode,
  ResolvedGraph,
  ResolverOptions,
} from '#package-manifest/contracts/ManifestTypes.ts';
import { DevDependencyPolicy } from '#package-manifest/core/DevDependencyPolicy.ts';
import {
  packageIdentity,
  ResolutionSearch,
  versionEntries,
  type PackageDemand,
  type Requirement,
  type SearchSolution,
} from '#package-manifest/resolver/ResolutionSearch.ts';

export class Resolver {
  private readonly devPolicy = new DevDependencyPolicy();

  constructor(private readonly registryCore: RegistryCore) {}

  async resolve(manifest: Manifest, options: ResolverOptions = {}): Promise<Result<ResolvedGraph>> {
    const minimumReleaseAge = options.minimumReleaseAge ?? DEFAULT_PACKAGE_MINIMUM_RELEASE_AGE;
    const minimumAgeMs = parseReleaseAgeMilliseconds(minimumReleaseAge);
    const nowMs = options.nowMs ?? Date.now();
    if (minimumAgeMs === undefined) {
      const reason = `Cannot resolve package versions. The value ${JSON.stringify(minimumReleaseAge)} is invalid for "packages.resolution.minimumReleaseAge".`;
      return fail([
        createDiagnostic(
          'PARSE_ERROR',
          'error',
          reason,
          { reason },
          'Use a duration such as "3d" or "12h", or set it to "0" to disable the cooldown.',
        ),
      ]);
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      const reason =
        'Cannot resolve package versions because UAPKG could not determine the current time to check release ages.';
      return fail([
        createDiagnostic('PARSE_ERROR', 'error', reason, { reason }, 'Check the system date and time, then try again.'),
      ]);
    }
    const rootDeps = new Map<string, Dependency[]>();
    for (const bucket of this.devPolicy.pickBuckets(manifest, true)) {
      for (const [name, dep] of Object.entries(bucket.map)) rootDeps.set(name, [...(rootDeps.get(name) ?? []), dep]);
    }
    for (const [name, dep] of Object.entries(options.overrides ?? {})) rootDeps.set(name, [dep]);
    const roots: Requirement[] = [...rootDeps]
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .flatMap(([name, dependencies]) =>
        dependencies.map((dep) => ({
          name,
          registry: dep.registry ?? DEFAULT_REGISTRY_ALIAS,
          range: dep.version,
          root: name,
          newTree: options.newRoots?.includes(name) ?? false,
          direct: true,
        })),
      );
    const search = new ResolutionSearch(this.registryCore, roots, options, minimumAgeMs, nowMs);
    if (
      options.previousLockfile &&
      options.updateTargets === undefined &&
      !options.frozen &&
      !options.newRoots?.length
    ) {
      const reusable = await search.solve(false, true);
      if ('solution' in reusable) return this.buildGraph(search, reusable.solution, []);
    }
    let strict = await search.solve(false);
    // Try again without the cooldown to see which releases would actually work
    // with the project's other packages. Only those can be reported as held back.
    let unrestricted = search.rejectedForAge ? await search.solve(true) : strict;
    if (
      !('solution' in strict) &&
      !('solution' in unrestricted) &&
      !options.frozen &&
      Number.isFinite(search.repairBudget)
    ) {
      // Find the fewest locked packages that must be downgraded to satisfy all
      // dependencies with the cooldown disabled. Use the same limit when the
      // cooldown is enabled so a recent release cannot cause an extra downgrade.
      let lower = 1;
      let upper = search.repairBudget;
      let witness: { budget: number; outcome: Awaited<ReturnType<ResolutionSearch['solve']>> } | undefined;
      while (lower < upper) {
        const budget = Math.floor((lower + upper) / 2);
        const outcome = await search.solve(true, false, budget);
        if ('solution' in outcome) {
          upper = budget;
          witness = { budget, outcome };
        } else lower = budget + 1;
      }
      unrestricted = witness?.budget === lower ? witness.outcome : await search.solve(true, false, lower);
      strict = await search.solve(false, false, lower);
    }
    if (!('solution' in strict)) {
      if (!('solution' in unrestricted)) return fail(unrestricted.diagnostics);
      const blocked = await this.blocked(search, unrestricted.solution);
      if (blocked.length === 0) return fail(strict.diagnostics);
      const diagnostics = await Promise.all(
        blocked.map(async ({ demand }) =>
          createReleaseAgeBlockedDiagnostic({
            packageName: demand.name,
            registry: demand.registry,
            ranges: [...new Set(demand.requirements.map((requirement) => requirement.range))],
            minimumReleaseAge,
            candidates: await search.blockedReleases(demand),
            overrideCommand: options.overrideCommand ?? 'uapkg install --ignore-release-age',
          }),
        ),
      );
      return fail(diagnostics);
    }
    const heldBack =
      'solution' in unrestricted
        ? await this.heldBack(
            search,
            strict.solution,
            unrestricted.solution,
            minimumAgeMs,
            nowMs,
            options.updateTargets,
          )
        : [];
    return this.buildGraph(search, strict.solution, heldBack);
  }

  private async blocked(
    search: ResolutionSearch,
    solution: SearchSolution,
  ): Promise<
    {
      demand: PackageDemand;
      version: string;
      publishedAt: number;
    }[]
  > {
    const blocked: { demand: PackageDemand; version: string; publishedAt: number }[] = [];
    for (const demand of [...solution.demands.values()].sort((left, right) =>
      left.key.localeCompare(right.key, 'en'),
    )) {
      const manifest = await search.getManifest(demand);
      if (!manifest.ok) continue;
      const version = solution.assignments.get(demand.key)!;
      const entry = versionEntries(manifest.value)[version]!;
      if (!search.ageAllowed(demand, version, entry))
        blocked.push({ demand, version, publishedAt: entry.meta.publishedAt });
    }
    return blocked;
  }

  private async heldBack(
    search: ResolutionSearch,
    selected: SearchSolution,
    unrestricted: SearchSolution,
    minimumAgeMs: number,
    nowMs: number,
    targets?: readonly string[],
  ): Promise<HeldBackRelease[]> {
    const rows = new Map<string, HeldBackRelease>();
    const policy = new SemverSelectionPolicy();
    const scope = targets?.length ? new Set<string>() : undefined;
    if (scope) {
      for (const solution of [selected, unrestricted]) {
        const queue = search.roots
          .filter((root) => targets!.includes(root.root))
          .map((root) => packageIdentity(root.registry, root.name));
        const visited = new Set<string>();
        for (let index = 0; index < queue.length; index++) {
          const key = queue[index]!;
          if (visited.has(key)) continue;
          visited.add(key);
          scope.add(key);
          queue.push(...(solution.edges.get(key) ?? []));
        }
      }
    }
    for (const blocked of await this.blocked(search, unrestricted)) {
      const currentDemand = selected.demands.get(blocked.demand.key);
      const direct =
        currentDemand &&
        currentDemand.requirements.every((requirement) => policy.matches(blocked.version, requirement.range)) &&
        semver.gt(blocked.version, selected.assignments.get(blocked.demand.key)!)
          ? blocked.demand.key
          : undefined;
      const affected = new Set<string>();
      if (direct) affected.add(direct);
      else {
        const visited = new Set<string>();
        const queue = [blocked.demand.key];
        for (let index = 0; index < queue.length; index++) {
          const key = queue[index]!;
          if (visited.has(key)) continue;
          visited.add(key);
          for (const [parent, children] of [...unrestricted.edges].sort(([left], [right]) =>
            left.localeCompare(right, 'en'),
          )) {
            if (!children.includes(key)) continue;
            if (
              selected.assignments.has(parent) &&
              semver.gt(unrestricted.assignments.get(parent)!, selected.assignments.get(parent)!)
            ) {
              affected.add(parent);
              continue;
            }
            queue.push(parent);
          }
        }
      }
      const eligibleInSeconds = releaseAgeRemainingSeconds(blocked.publishedAt, minimumAgeMs, nowMs);
      for (const identity of affected) {
        if (scope && !scope.has(identity)) continue;
        const demand = selected.demands.get(identity)!;
        if ((rows.get(identity)?.eligibleInSeconds ?? -1) >= eligibleInSeconds) continue;
        rows.set(identity, {
          name: demand.name,
          registry: demand.registry,
          selectedVersion: selected.assignments.get(identity)!,
          blockedVersion: unrestricted.assignments.get(identity)!,
          ...(identity === blocked.demand.key
            ? {}
            : { blockedDependency: { name: blocked.demand.name, version: blocked.version } }),
          publishedAt: blocked.publishedAt,
          eligibleInSeconds,
        });
      }
    }
    return [...rows.values()].sort(
      (left, right) => left.name.localeCompare(right.name, 'en') || left.registry.localeCompare(right.registry, 'en'),
    );
  }

  private async buildGraph(
    search: ResolutionSearch,
    solution: SearchSolution,
    heldBack: readonly HeldBackRelease[],
  ): Promise<Result<ResolvedGraph>> {
    const identities = new Map<string, PackageNode>();
    const nodes = new Map<string, PackageNode>();
    const diagnostics: Diagnostic[] = [];
    for (const demand of [...solution.demands.values()].sort((left, right) =>
      left.key.localeCompare(right.key, 'en'),
    )) {
      const manifest = await search.getManifest(demand);
      if (!manifest.ok) return manifest;
      diagnostics.push(...manifest.diagnostics);
      const version = solution.assignments.get(demand.key)!;
      const entry = versionEntries(manifest.value)[version]!;
      const node: PackageNode = {
        name: demand.name,
        version,
        registry: demand.registry,
        integrity: entry.releaseFiles.package.integrity.hash,
        ...(entry.gitTree === undefined ? {} : { gitTree: entry.gitTree }),
        dependencies: new Map(),
      };
      identities.set(demand.key, node);
      nodes.set(demand.registry + '::' + demand.name + '@' + version, node);
    }
    for (const [parent, children] of solution.edges) {
      const node = identities.get(parent)!;
      const dependencies = node.dependencies as Map<string, PackageNode>;
      for (const child of children) dependencies.set(identities.get(child)!.name, identities.get(child)!);
    }
    const roots = [...new Set(search.roots.map((root) => packageIdentity(root.registry, root.name)))].map((identity) =>
      identities.get(identity)!,
    );
    return ok({ nodes, roots, heldBack }, diagnostics);
  }
}
