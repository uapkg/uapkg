import fs from 'node:fs';
import path from 'node:path';

export type LifecycleKind = 'integration' | 'prepack' | 'postinstall';
export type LifecycleEntries = Partial<Record<LifecycleKind, string>>;

const conventions = {
  integration: '.uapkg/integration',
  prepack: '.uapkg/lifecycle/prepack',
  postinstall: '.uapkg/lifecycle/postinstall',
} as const;
const supported = ['ts', 'js', 'mjs'];

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

/** The same checks apply to explicit overrides, conventional files and worker inputs. */
export function checkedEntry(packageRoot: string, value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    path.win32.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').includes('..') ||
    !supported.includes(path.extname(value).slice(1))
  ) {
    throw new Error('Lifecycle entry must be a package-relative .ts, .js, or .mjs file: ' + String(value));
  }
  const root = fs.realpathSync.native(packageRoot);
  const file = path.resolve(root, value);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Lifecycle entry is missing: ' + value);
  if (!within(root, fs.realpathSync.native(file))) throw new Error('Lifecycle entry is outside the package: ' + value);
  return path.relative(root, file).split(path.sep).join('/');
}

/** Discover file names only. Reading the manifest and inspecting file metadata never imports package code. */
export function discoverEntries(
  packageRoot: string,
  manifest: unknown,
  kinds: readonly LifecycleKind[] = ['integration', 'prepack', 'postinstall'],
): LifecycleEntries {
  const data = object(manifest);
  const scripts = object(object(data.lifecycle).scripts);
  const overrides = {
    integration: object(data.integration).entry,
    prepack: scripts.prepack,
    postinstall: scripts.postinstall,
  };
  const entries: LifecycleEntries = {};
  for (const kind of kinds) {
    if (overrides[kind] !== undefined) {
      entries[kind] = checkedEntry(packageRoot, overrides[kind]);
      continue;
    }
    const hits = supported
      .map((ext) => conventions[kind] + '.' + ext)
      .filter((file) => fs.lstatSync(path.join(packageRoot, file), { throwIfNoEntry: false }) !== undefined);
    if (hits.length > 1) throw new Error('Ambiguous ' + kind + ' entries: ' + hits.join(', '));
    if (hits.length === 1) entries[kind] = checkedEntry(packageRoot, hits[0]);
  }
  return entries;
}
