import fs from 'node:fs';
import path from 'node:path';
import { discoverEntries, prepareLifecycleEntry, runLifecycleEntry } from '@uapkg/lifecycle';
import type { PackManifest, PackOptions } from '#pack/contracts/PackTypes.ts';

export async function runPrepack(pluginRoot: string, manifest: PackManifest, options: PackOptions): Promise<void> {
  const entry = discoverEntries(pluginRoot, manifest, ['prepack']).prepack;
  if (!entry || options.dryRun || options.ignoreScripts) return;
  const selector = manifest.lifecycle?.runtime?.node;
  let nodeExecutable = options.nodeExecutable;
  if (selector && !nodeExecutable) {
    if (!options.resolveNode)
      throw new Error('The prepack hook requests Node ' + selector + ' but no runtime resolver was provided.');
    nodeExecutable = await options.resolveNode(selector, pluginRoot);
  }
  await runLifecycleEntry({
    kind: 'prepack',
    entry,
    packageRoot: pluginRoot,
    workspaceRoot: pluginRoot,
    workDir: pluginRoot,
    nodeExecutable,
  });
}

/** Never traverse installed packages or include UAPKG's workstation-specific files. */
export function excludedPackagePaths(root: string, manifest: PackManifest): (file: string) => boolean {
  const paths = new Set([
    '.git',
    'node_modules',
    'uapkg.lock',
    'uapkg.integration-ownership.json',
    '.uapkg/config.json',
    '.uapkg/state',
    '.uapkg/locks',
    '.uapkg/lifecycle-work',
    '.uapkg/integration-transaction.json',
  ]);
  for (const bucket of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.overrides,
  ]) {
    for (const [name, declaration] of Object.entries(bucket ?? {})) {
      paths.add('Plugins/' + name);
      if (
        declaration &&
        typeof declaration === 'object' &&
        'path' in declaration &&
        typeof declaration.path === 'string'
      ) {
        paths.add(declaration.path.replace(/^\.\//, '').replace(/\/$/, ''));
      }
    }
  }
  const lock = path.join(root, 'uapkg.lock');
  if (fs.existsSync(lock)) {
    const data = JSON.parse(fs.readFileSync(lock, 'utf8'));
    for (const [name, value] of Object.entries(data.packages ?? {})) {
      paths.add('Plugins/' + name);
      if (value && typeof value === 'object' && 'path' in value && typeof value.path === 'string')
        paths.add(value.path);
    }
  }
  return (file) => {
    const segments = file.split('/');
    while (segments.length) {
      if (paths.has(segments.join('/'))) return true;
      segments.pop();
    }
    return false;
  };
}

export async function releaseEntryFiles(
  root: string,
  manifest: PackManifest,
  excluded: (file: string) => boolean,
): Promise<Set<string>> {
  const files = new Set<string>();
  for (const entry of Object.values(discoverEntries(root, manifest))) {
    const bundle = await prepareLifecycleEntry(root, entry);
    for (const file of bundle.files) {
      if (excluded(file)) throw new Error('Lifecycle entry uses an excluded workspace file: ' + file);
      files.add(file);
    }
  }
  return files;
}
