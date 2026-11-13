import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import { satisfies, valid } from 'semver';
import {
  createBuildMetadata,
  renderBuildMetadataModule,
  renderCliLauncher,
  verifyProductionBuild,
} from './CliBuild.ts';

export const CLI_ROOT = path.resolve(import.meta.dirname, '..');
export const WORKSPACE_ROOT = path.resolve(CLI_ROOT, '../..');
export const RUNTIME_TEMPLATE_ROOT = path.join(CLI_ROOT, 'build/runtime');
export const NPM_PACKAGE_ROOT = path.join(CLI_ROOT, 'package');
export const BUILD_NODE_VERSION = '26.13.1';
export const BUILD_NPM_VERSION = '12.2.2';

interface PackageManifest {
  name: string;
  version: string;
  type?: string;
  description?: string;
  license?: string;
  repository?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  exports?: Record<string, { types?: string; default?: string }>;
}

interface RuntimeLock {
  name: string;
  version: string;
  lockfileVersion: number;
  packages: Record<string, Record<string, unknown>>;
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function runChecked(command: string, args: string[], cwd: string, env = process.env): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} exited with ${String(result.status)}.\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

/** The CLI package ships the same frozen external graph as standalone builds. */
export function createRuntimePackageManifest(
  source: PackageManifest,
  runtime: PackageManifest,
): Record<string, unknown> {
  return {
    name: source.name,
    version: source.version,
    description: 'UAPKG CLI engine, selected and run by the UAPKG launcher.',
    license: source.license ?? 'MIT',
    repository: source.repository,
    type: 'module',
    sideEffects: false,
    engines: runtime.engines,
    files: ['dist', 'README.md', 'LICENSE'],
    types: './dist/types/uapkg/index.d.ts',
    exports: { '.': { types: './dist/types/uapkg/index.d.ts', default: './dist/index.js' } },
    dependencies: runtime.dependencies,
  };
}

export function stampRuntimeLock(lock: RuntimeLock, source: PackageManifest, runtime: PackageManifest): RuntimeLock {
  if (lock.lockfileVersion !== 3 || !lock.packages['']) throw new Error('The CLI runtime requires a v3 npm lockfile.');
  const lockedDependencies = lock.packages[''].dependencies;
  if (JSON.stringify(lockedDependencies) !== JSON.stringify(runtime.dependencies)) {
    throw new Error('The CLI runtime lock is stale. Update build/runtime/package-lock.json before packaging.');
  }
  return {
    ...lock,
    name: source.name,
    version: source.version,
    packages: {
      ...lock.packages,
      '': { ...lock.packages[''], name: source.name, version: source.version, engines: runtime.engines },
    },
  };
}

export interface WorkspacePackage {
  directory: string;
  manifest: PackageManifest;
}

/** Source dependency changes must deliberately update the isolated release graph. */
export function validateRuntimeDependencyPins(
  packages: readonly WorkspacePackage[],
  runtime: Record<string, string>,
): void {
  const owners = new Map(packages.map((pkg) => [pkg.manifest.name, pkg.manifest]));
  const pending = ['@uapkg/cli'];
  const visited = new Set<string>();
  const bundled = new Set(['semver']);
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const owner = owners.get(name);
    if (!owner) throw new Error(`The engine dependency closure is missing ${name}.`);
    for (const [dependency, version] of Object.entries({ ...owner.dependencies, ...owner.optionalDependencies })) {
      if (dependency.startsWith('@uapkg/')) {
        pending.push(dependency);
        continue;
      }
      if (bundled.has(dependency)) continue;
      const pinned = runtime[dependency];
      if (!pinned || valid(version) !== version || pinned !== version) {
        throw new Error(
          `Runtime dependency ${name} -> ${dependency}@${version} differs from the release pin ${pinned ?? '(missing)'}. Update build/runtime/package.json and its lock deliberately.`,
        );
      }
    }
    for (const [dependency, range] of Object.entries(owner.peerDependencies ?? {})) {
      if (dependency.startsWith('@uapkg/') || bundled.has(dependency)) continue;
      if (!runtime[dependency] || !satisfies(runtime[dependency], range)) {
        throw new Error(
          `Runtime dependency ${dependency}@${runtime[dependency] ?? '(missing)'} does not satisfy ${name}'s peer ${range}.`,
        );
      }
    }
  }
}

function workspacePackages(): WorkspacePackage[] {
  return readdirSync(path.join(WORKSPACE_ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      directory: entry.name,
      manifest: readJson<PackageManifest>(path.join(WORKSPACE_ROOT, 'packages', entry.name, 'package.json')),
    }));
}

/** Keep declaration identity and public exports, without requiring sibling npm releases. */
function copyDeclarations(output: string): void {
  const packages = workspacePackages();
  const exports = new Map<string, string>();
  for (const pkg of packages) {
    for (const [subpath, value] of Object.entries(pkg.manifest.exports ?? {})) {
      if (!value.types) continue;
      const specifier = `${pkg.manifest.name}${subpath === '.' ? '' : subpath.slice(1)}`;
      exports.set(specifier, path.join(output, 'dist/types', pkg.directory, value.types.replace(/^\.\/dist\//, '')));
    }
  }
  for (const pkg of packages) {
    const sourceRoot = path.join(WORKSPACE_ROOT, 'packages', pkg.directory, 'dist');
    if (!existsSync(sourceRoot)) continue;
    for (const entry of readdirSync(sourceRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue;
      const sourcePath = path.join(entry.parentPath, entry.name);
      const destination = path.join(output, 'dist/types', pkg.directory, path.relative(sourceRoot, sourcePath));
      let text = readFileSync(sourcePath, 'utf8');
      text = text.replace(/(["'])(@uapkg\/[^"']+)\1/g, (_match, quote: string, specifier: string) => {
        const target = exports.get(specifier);
        if (!target) throw new Error(`No declaration export for ${specifier}.`);
        let relative = path
          .relative(path.dirname(destination), target)
          .replaceAll('\\', '/')
          .replace(/\.d\.ts$/, '.js');
        if (!relative.startsWith('.')) relative = `./${relative}`;
        return `${quote}${relative}${quote}`;
      });
      text = text.replace(/^\/\/# sourceMappingURL=.*$/gm, '');
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, text);
    }
  }
}

export async function prepareNpmPackage(): Promise<string> {
  await verifyProductionBuild();
  const source = readJson<PackageManifest>(path.join(CLI_ROOT, 'package.json'));
  const runtime = readJson<PackageManifest>(path.join(RUNTIME_TEMPLATE_ROOT, 'package.json'));
  validateRuntimeDependencyPins(workspacePackages(), runtime.dependencies ?? {});
  const lock = readJson<RuntimeLock>(path.join(RUNTIME_TEMPLATE_ROOT, 'package-lock.json'));
  const stampedLock = stampRuntimeLock(lock, source, runtime);
  const destination = path.resolve(NPM_PACKAGE_ROOT);
  if (path.dirname(destination) !== CLI_ROOT || path.basename(destination) !== 'package')
    throw new Error('Invalid generated package directory.');
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(path.join(destination, 'dist/build'), { recursive: true });
  writeJson(path.join(destination, 'package.json'), createRuntimePackageManifest(source, runtime));
  writeJson(path.join(destination, 'dist/runtime-lock.json'), stampedLock);

  const external = Object.keys(runtime.dependencies ?? {});
  // Keep profile initialization ahead of importing application modules. Bundling the
  // wrapper and application together can move module initialization across this boundary.
  const jobs = [
    ['cli-bootstrap', path.join(CLI_ROOT, 'dist/cli-bootstrap.js')],
    ['index', path.join(CLI_ROOT, 'dist/index.js')],
    ['profile', path.join(WORKSPACE_ROOT, 'packages/uapkg-common/dist/runtime/UapkgRuntimeProfile.js')],
  ];
  for (const [name, entryPoint] of jobs) {
    const result = await build({
      entryPoints: [entryPoint],
      outfile: path.join(destination, 'dist', `${name}.js`),
      absWorkingDir: CLI_ROOT,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node26',
      external,
      tsconfigRaw: { compilerOptions: {} },
      conditions: ['node', 'import', 'default'],
      banner: {
        js: 'import { createRequire as __uapkgCreateRequire } from "node:module"; const require = __uapkgCreateRequire(import.meta.url);',
      },
      sourcemap: false,
      metafile: true,
      logLevel: 'silent',
    });
    for (const built of Object.values(result.metafile.outputs)) {
      if (
        built.imports.some(
          (entry) => entry.external && (entry.path.startsWith('@uapkg/') || entry.path.startsWith('#')),
        )
      ) {
        throw new Error('The npm engine still imports workspace modules.');
      }
    }
  }
  writeFileSync(
    path.join(destination, 'dist/cli.js'),
    renderCliLauncher().replace("from '@uapkg/common'", "from './profile.js'"),
  );
  writeFileSync(
    path.join(destination, 'dist/build/BuildMetadata.js'),
    renderBuildMetadataModule(createBuildMetadata('production', source.version)),
  );
  copyDeclarations(destination);
  const bundledSemver = createRequire(path.join(WORKSPACE_ROOT, 'package.json')).resolve('semver/package.json');
  mkdirSync(path.join(destination, 'dist/licenses'), { recursive: true });
  cpSync(path.join(path.dirname(bundledSemver), 'LICENSE'), path.join(destination, 'dist/licenses/semver-LICENSE'));
  cpSync(path.join(WORKSPACE_ROOT, 'LICENSE'), path.join(destination, 'LICENSE'));
  writeFileSync(
    path.join(destination, 'README.md'),
    '# UAPKG CLI engine\n\nThis package is downloaded and run by the UAPKG launcher. Install the launcher from the [UAPKG releases](https://github.com/MaximDevoir/uapkg/releases).\n',
  );
  return destination;
}
