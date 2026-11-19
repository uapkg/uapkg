import { normalizeDependencyDeclaration, type Dependency, type Manifest } from '@uapkg/package-manifest-schema';
import type { DependencyBucket } from '@uapkg/package-manifest';

export type PackageOperationName = 'install' | 'add' | 'update' | 'remove';

export function findDeclaredDependency(
  manifest: Manifest,
  name: string,
): { bucket: DependencyBucket; dependency: Dependency } | undefined {
  for (const bucket of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const entries = manifest[bucket];
    if (entries && Object.hasOwn(entries, name)) {
      return { bucket, dependency: normalizeDependencyDeclaration(entries[name]) };
    }
  }
  return undefined;
}

/** A reviewable retry command; no shell executes this string. */
export function releaseAgeOverrideCommand(command: PackageOperationName, args: readonly string[] = []): string {
  const quote = (value: string) => (/^[A-Za-z0-9_@./:^*+-]+$/.test(value) ? value : JSON.stringify(value));
  return ['uapkg', command, ...args.filter((arg) => arg !== '--ignore-release-age'), '--ignore-release-age']
    .map(quote)
    .join(' ');
}
