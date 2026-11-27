import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from '@uapkg/package-manifest-schema';
import type { CompositionRoot } from '#cli/app/CompositionRoot.ts';
import { resolvePackageRegistry } from '#cli/commands/resolvePackageRegistry.ts';

export async function resolvePackageTrust(
  root: CompositionRoot,
  packageName: string,
  requested: string | undefined,
  manifest?: Manifest,
) {
  // Yank and related operations also work outside a package workspace.
  if (requested === undefined && !manifest && lstatSync(join(root.cwd, 'uapkg.json'), { throwIfNoEntry: false })) {
    const read = await root.packageManifest.readManifest();
    if (!read.ok) throw new Error(read.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
    manifest = read.value;
  }
  const selected = await resolvePackageRegistry(root, manifest, packageName, requested);
  if (!selected.ok) {
    throw new Error(
      selected.diagnostics.flatMap(({ message, hint }) => (hint ? [message, hint] : [message])).join('\n'),
    );
  }
  return root.registryTrustResolver.resolve(selected.value);
}
