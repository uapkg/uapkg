import { DEFAULT_REGISTRY_ALIAS, RegistryNameSchema, type RegistryName } from '@uapkg/common-schema';
import {
  createPackageRegistryAmbiguousDiagnostic,
  createRegistryNotFoundDiagnostic,
  fail,
  ok,
  type Result,
} from '@uapkg/diagnostics';
import type { Manifest } from '@uapkg/package-manifest-schema';
import type { CompositionRoot } from '#cli/app/CompositionRoot.ts';

/** Consult the default catalog only when a workspace declaration makes the package name ambiguous. */
export async function resolvePackageRegistry(
  root: Pick<CompositionRoot, 'registryCore'>,
  manifest: Manifest | undefined,
  packageName: string,
  requestedAlias?: string,
): Promise<Result<RegistryName>> {
  if (requestedAlias !== undefined) {
    const alias = RegistryNameSchema.safeParse(requestedAlias);
    return alias.success ? ok(alias.data) : fail([createRegistryNotFoundDiagnostic(requestedAlias)]);
  }
  if (!manifest) return ok(DEFAULT_REGISTRY_ALIAS);

  const alternatives = new Set<string>();
  function record(alias: string | undefined) {
    if (alias && alias !== DEFAULT_REGISTRY_ALIAS) alternatives.add(alias);
  }
  for (const declarations of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.kind === 'project' ? manifest.overrides : undefined,
  ]) {
    if (declarations && Object.hasOwn(declarations, packageName)) record(declarations[packageName]?.registry);
  }
  if (manifest.name === packageName) record(manifest.publish?.registry);
  for (const release of manifest.permissions?.releases ?? []) {
    if (release.packageName === packageName) record(release.registry);
  }
  if (!alternatives.size) return ok(DEFAULT_REGISTRY_ALIAS);

  const registry = root.registryCore.getOrCreateRegistry(DEFAULT_REGISTRY_ALIAS);
  if (!registry.ok) return registry;
  const entry = await registry.value.getPackageManifest(packageName, DEFAULT_REGISTRY_ALIAS);
  const diagnostics = [...registry.diagnostics, ...entry.diagnostics];
  if (entry.ok) {
    return fail([
      ...diagnostics,
      createPackageRegistryAmbiguousDiagnostic(packageName, [DEFAULT_REGISTRY_ALIAS, ...[...alternatives].sort()]),
    ]);
  }
  const errors = entry.diagnostics.filter((diagnostic) => diagnostic.level === 'error');
  if (errors.length && errors.every((diagnostic) => diagnostic.code === 'PACKAGE_NOT_FOUND')) {
    return ok(
      DEFAULT_REGISTRY_ALIAS,
      diagnostics.filter((diagnostic) => diagnostic.code !== 'PACKAGE_NOT_FOUND'),
    );
  }
  return fail(diagnostics);
}
