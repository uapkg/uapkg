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
  type ReleaseBuild,
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

export async function buildNativeArtifacts(output: string, format: 'node' | 'sea' = 'node'): Promise<ReleaseBuild> {
  if (process.versions.node !== BUILD_NODE_VERSION) {
    throw new Error(`Release builds require Node ${BUILD_NODE_VERSION}; use the repository Vite+ toolchain.`);
  }
  const platform = currentPlatform();
  const version = readJson<{ version: string }>(path.join(CLI_ROOT, 'package.json')).version;
  const root = path.resolve(output);
  const engineRoot = path.join(root, 'cli');
  const packageRoot = path.join(root, 'runtime-package');
  const probeRoot = path.join(root, 'sea-smoke');
  const seaBuildRoot = path.join(root, 'sea-build');
  // Only replace dedicated generated children, never the caller's output directory.
  for (const generated of [engineRoot, packageRoot, probeRoot, seaBuildRoot]) {
    if (path.dirname(generated) !== root) throw new Error('Invalid native output directory.');
    rmSync(generated, { recursive: true, force: true });
    mkdirSync(generated, { recursive: true });
  }
  await prepareNpmPackage();
  cpSync(NPM_PACKAGE_ROOT, packageRoot, { recursive: true });
  installRuntimeDependencies(packageRoot);

  const executableName = process.platform === 'win32' ? 'node.exe' : 'node';
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
  const artifact = path.join(root, artifactName('cli', version, platform));
  await archiveDirectory(engineRoot, artifact);
  const build: ReleaseBuild = {
    schemaVersion: 1,
    product: 'cli',
    version,
    engineFormat: format,
    artifacts: [inspectArtifact(artifact, platform)],
  };
  writeJson(path.join(root, `build-${platform}.json`), build);
  return build;
}

export async function buildLauncherArtifact(output: string, launcher: string): Promise<ReleaseBuild> {
  const platform = currentPlatform();
  const executable = path.resolve(launcher);
  const version = runChecked(executable, ['launcher', '--version'], path.dirname(executable)).trim();
  assertExactVersion(version);
  const root = path.resolve(output);
  const directory = path.join(root, 'launcher');
  if (path.dirname(directory) !== root) throw new Error('Invalid launcher output directory.');
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const name = process.platform === 'win32' ? 'uapkg.exe' : 'uapkg';
  cpSync(executable, path.join(directory, name));
  chmodSync(path.join(directory, name), 0o755);
  const artifact = path.join(root, artifactName('launcher', version, platform));
  await archiveDirectory(directory, artifact);
  const build: ReleaseBuild = {
    schemaVersion: 1,
    product: 'launcher',
    version,
    artifacts: [inspectArtifact(artifact, platform)],
  };
  writeJson(path.join(root, `build-${platform}.json`), build);
  return build;
}

export function launcherVersionFromCargo(workspaceRoot: string): string {
  const manifest = readFileSync(path.join(workspaceRoot, 'launcher/Cargo.toml'), 'utf8');
  const version = /^version\s*=\s*"([^"]+)"/m.exec(manifest)?.[1];
  if (!version) throw new Error('Launcher Cargo.toml has no package version.');
  return version;
}
