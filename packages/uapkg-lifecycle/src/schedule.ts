interface SourceRelease {
  packageName: string;
  registry: string;
  registryId: string;
  version: string;
  integrity: string;
}

export function sameRelease(a: SourceRelease, b: SourceRelease): boolean {
  return (
    a.packageName === b.packageName &&
    a.registryId === b.registryId &&
    a.version === b.version &&
    a.integrity === b.integrity
  );
}

export function releaseCapabilities<T extends string>(
  grants: readonly (SourceRelease & { capabilities: readonly T[] })[] | undefined,
  release: SourceRelease,
) {
  return grants?.find((g) => sameRelease(g, release))?.capabilities;
}

export function orderedReleases<T extends { packageName: string; dependencies: readonly string[] }>(
  releases: readonly T[],
): T[] {
  const byName = new Map(releases.map((r) => [String(r.packageName), r]));
  const ordered: T[] = [];
  const visited = new Set<string>();
  function visit(release: T) {
    if (visited.has(release.packageName)) return;
    visited.add(release.packageName);
    for (const child of [...release.dependencies].sort()) {
      const dependency = byName.get(child);
      if (dependency) visit(dependency);
    }
    ordered.push(release);
  }
  for (const name of [...byName.keys()].sort()) visit(byName.get(name)!);
  return ordered;
}
