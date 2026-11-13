import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  BUILD_NODE_VERSION,
  BUILD_NPM_VERSION,
  CLI_ROOT,
  NPM_PACKAGE_ROOT,
  prepareNpmPackage,
  readJson,
  runChecked,
  writeJson,
} from '../../packages/uapkg/build/EnginePackage.ts';
import {
  archiveDirectory,
  artifactName,
  assertExactVersion,
  currentPlatform,
  inspectArtifact,
  type EngineDescriptor,
  type ReleaseCatalog,
} from './ReleaseArtifacts.ts';
import { buildSea } from './SeaBuild.ts';

export function npmCliPath(): string {
  const executableDirectory = path.dirname(process.execPath);
  const candidates = [
    path.join(executableDirectory, 'node_modules/npm/bin/npm-cli.js'),
    path.join(executableDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error('The release Node installation must include npm.');
  return found;
}

export function installRuntimeDependencies(directory: string, npmVersion = BUILD_NPM_VERSION): void {
  assertExactVersion(npmVersion);
  // The packaged engine supports a range of npm versions; release construction
  // itself always uses this exact npm and the checked-in frozen dependency graph.
  cpSync(path.join(directory, 'dist/runtime-lock.json'), path.join(directory, 'package-lock.json'));
  runChecked(
    process.execPath,
    [
      npmCliPath(),
      'exec',
      '--yes',
      `--package=npm@${npmVersion}`,
      '--',
      'npm',
      'ci',
      '--ignore-scripts',
      '--omit=dev',
      '--include=optional',
      '--no-bin-links',
      '--no-audit',
      '--no-fund',
      '--engine-strict',
    ],
    directory,
    { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', npm_config_ignore_scripts: 'true' },
  );
  if (
    !readFileSync(path.join(directory, 'package-lock.json')).equals(
      readFileSync(path.join(directory, 'dist/runtime-lock.json')),
    )
  ) {
    throw new Error('npm changed the frozen engine dependency lock.');
  }
}

export async function buildNativeArtifacts(
  output: string,
  launcher: string,
  format: 'node' | 'sea' = 'node',
): Promise<ReleaseCatalog> {
  if (process.versions.node !== BUILD_NODE_VERSION) {
    throw new Error(`Release builds require Node ${BUILD_NODE_VERSION}; use the repository Vite+ toolchain.`);
  }
  const platform = currentPlatform();
  const version = readJson<{ version: string }>(path.join(CLI_ROOT, 'package.json')).version;
  const launcherPath = path.resolve(launcher);
  const launcherVersion = runChecked(launcherPath, ['launcher', '--version'], CLI_ROOT).trim();
  const root = path.resolve(output);
  const engineRoot = path.join(root, 'cli');
  const launcherRoot = path.join(root, 'launcher');
  const bundleRoot = path.join(root, 'bundle');
  const packageRoot = path.join(root, 'runtime-package');
  const probeRoot = path.join(root, 'sea-smoke');
  const seaBuildRoot = path.join(root, 'sea-build');
  // Only replace dedicated generated children, never the caller's output directory.
  for (const generated of [engineRoot, launcherRoot, bundleRoot, packageRoot, probeRoot, seaBuildRoot]) {
    if (path.dirname(generated) !== root) throw new Error('Invalid native output directory.');
    rmSync(generated, { recursive: true, force: true });
    mkdirSync(generated, { recursive: true });
  }
  await prepareNpmPackage();
  cpSync(NPM_PACKAGE_ROOT, packageRoot, { recursive: true });
  installRuntimeDependencies(packageRoot);

  const executableName = process.platform === 'win32' ? 'node.exe' : 'node';
  const launcherName = process.platform === 'win32' ? 'uapkg.exe' : 'uapkg';
  if (format === 'node') {
    cpSync(packageRoot, engineRoot, { recursive: true });
    const runtimeRoot = path.join(engineRoot, 'runtime');
    mkdirSync(runtimeRoot, { recursive: true });
    cpSync(process.execPath, path.join(runtimeRoot, executableName));
    chmodSync(path.join(runtimeRoot, executableName), 0o755);
  } else {
    buildSea(packageRoot, engineRoot, probeRoot, seaBuildRoot);
    cpSync(path.join(packageRoot, 'LICENSE'), path.join(engineRoot, 'LICENSE'));
  }
  const nodeRoot = path.dirname(process.execPath);
  const license = [path.join(nodeRoot, 'LICENSE'), path.join(nodeRoot, '../LICENSE')].find(existsSync);
  if (!license) throw new Error('The pinned Node distribution license is missing.');
  cpSync(license, path.join(engineRoot, 'NODE-LICENSE'));

  const descriptor: EngineDescriptor = {
    schemaVersion: 1,
    version,
    platform,
    kind: format,
    executable: format === 'node' ? `runtime/${executableName}` : `engine${process.platform === 'win32' ? '.exe' : ''}`,
    args: format === 'node' ? ['dist/cli.js'] : [],
  };
  writeJson(path.join(engineRoot, 'engine.json'), descriptor);
  cpSync(launcherPath, path.join(launcherRoot, launcherName));
  chmodSync(path.join(launcherRoot, launcherName), 0o755);
  cpSync(launcherPath, path.join(bundleRoot, launcherName));
  chmodSync(path.join(bundleRoot, launcherName), 0o755);
  cpSync(engineRoot, path.join(bundleRoot, 'cli'), { recursive: true });
  writeJson(path.join(bundleRoot, 'uapkg-install.json'), {
    schemaVersion: 1,
    installMethod: 'standalone',
    defaultCliVersion: version,
    bundledEngine: 'cli',
  });
  const catalog: ReleaseCatalog = { schemaVersion: 1, cliVersion: version, launcherVersion, artifacts: [] };
  for (const [kind, directory, artifactVersion] of [
    ['cli', engineRoot, version],
    ['launcher', launcherRoot, launcherVersion],
    ['bundle', bundleRoot, version],
  ] as const) {
    const artifact = path.join(root, artifactName(kind, artifactVersion, platform));
    await archiveDirectory(directory, artifact);
    catalog.artifacts.push(inspectArtifact(artifact, kind, platform));
  }
  writeJson(path.join(root, `release-${platform}.json`), { ...catalog, engineFormat: format });
  return catalog;
}

export function launcherVersionFromCargo(workspaceRoot: string): string {
  const manifest = readFileSync(path.join(workspaceRoot, 'launcher/Cargo.toml'), 'utf8');
  const version = /^version\s*=\s*"([^"]+)"/m.exec(manifest)?.[1];
  if (!version) throw new Error('Launcher Cargo.toml has no package version.');
  return version;
}
