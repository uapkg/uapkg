import { globSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { ProcessRunner } from '../dev-build/ProcessRunner.ts';
import { assertExactVersion } from '../release/ReleaseContract.ts';

function table(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a TOML table.');
  return value as Record<string, unknown>;
}

function readToml(file: string): Record<string, unknown> {
  return parse(readFileSync(file, 'utf8'));
}

function sharedVersion(manifest: Record<string, unknown>): string {
  const version = table(table(manifest.workspace).package).version;
  assertExactVersion(version);
  return version;
}

/** Release identity remains file-based and does not require an installed Rust toolchain. */
export function readLauncherCargoVersion(workspaceRoot: string): string {
  return sharedVersion(readToml(path.join(workspaceRoot, 'launcher/Cargo.toml')));
}

function launcherVersion(workspaceRoot: string): string {
  const manifest = JSON.parse(readFileSync(path.join(workspaceRoot, 'launcher/package.json'), 'utf8')) as {
    name?: unknown;
    private?: unknown;
    version?: unknown;
  };
  if (manifest.name !== 'uapkg-launcher' || manifest.private !== true) {
    throw new Error('The launcher Changesets target must be named uapkg-launcher and private.');
  }
  assertExactVersion(manifest.version);
  return manifest.version;
}

function workspacePackages(directory: string, manifest: Record<string, unknown>): string[] {
  const workspace = table(manifest.workspace);
  const members = workspace.members;
  const exclude = workspace.exclude ?? [];
  if (!Array.isArray(members) || !members.every((member) => typeof member === 'string')) {
    throw new Error('Expected launcher workspace members.');
  }
  if (!Array.isArray(exclude) || !exclude.every((member) => typeof member === 'string')) {
    throw new Error('Expected launcher workspace exclusions.');
  }
  const isExcluded = (crate: string) =>
    exclude.some((pattern) => path.matchesGlob(path.relative(directory, crate).replaceAll('\\', '/'), pattern));
  const manifests = new Set([path.join(directory, 'Cargo.toml')]);
  for (const member of members) {
    const matches = globSync(`${member}/Cargo.toml`, { cwd: directory });
    if (!matches.length) throw new Error(`Launcher workspace member does not exist: ${member}`);
    for (const match of matches) {
      const file = path.resolve(directory, match);
      if (!isExcluded(path.dirname(file))) manifests.add(file);
    }
  }
  const packages: string[] = [];
  // Set iteration also visits discovered path dependencies, including their dependencies.
  for (const file of manifests) {
    const crate = readToml(file);
    const pkg = table(crate.package);
    const inherited = pkg.version && typeof pkg.version === 'object' && !Array.isArray(pkg.version);
    if (typeof pkg.name !== 'string' || !inherited || table(pkg.version).workspace !== true) {
      throw new Error(`Launcher crate must use version.workspace = true: ${file}`);
    }
    packages.push(pkg.name);
    for (const section of [crate, ...Object.values(table(crate.target ?? {})).map(table)]) {
      for (const key of ['dependencies', 'build-dependencies', 'dev-dependencies']) {
        for (const [name, value] of Object.entries(table(section[key] ?? {}))) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          let dependency = table(value);
          let base = path.dirname(file);
          if (dependency.workspace === true) {
            const inheritedDependency = table(workspace.dependencies ?? {})[name];
            if (typeof inheritedDependency === 'string') continue;
            dependency = table(inheritedDependency);
            base = directory;
          }
          if (typeof dependency.path !== 'string') continue;
          const dependencyDirectory = path.resolve(base, dependency.path);
          const relative = path.relative(directory, dependencyDirectory);
          if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
          if (!isExcluded(dependencyDirectory)) manifests.add(path.join(dependencyDirectory, 'Cargo.toml'));
        }
      }
    }
  }
  return packages;
}

function assertLockVersions(file: string, packages: string[], version: string): void {
  const entries = readToml(file).package;
  if (!Array.isArray(entries)) throw new Error('Expected launcher Cargo.lock package entries.');
  for (const name of packages) {
    const matches = entries.map(table).filter((pkg) => pkg.name === name && pkg.source === undefined);
    if (matches.length !== 1 || matches[0].version !== version) {
      throw new Error(`Launcher Cargo.lock is stale for ${name}. Run vp run launcher:version:sync.`);
    }
  }
}

export function checkLauncherVersion(workspaceRoot: string): void {
  const directory = path.join(workspaceRoot, 'launcher');
  const version = launcherVersion(workspaceRoot);
  const manifest = readToml(path.join(directory, 'Cargo.toml'));
  if (sharedVersion(manifest) !== version) {
    throw new Error('Launcher Cargo version differs from package.json. Run vp run launcher:version:sync.');
  }
  assertLockVersions(path.join(directory, 'Cargo.lock'), workspacePackages(directory, manifest), version);
}

/** Preserve comments and formatting while changing only the shared version's value. */
function replaceSharedVersion(source: string, version: string): string {
  let inSharedPackage = false;
  let replacements = 0;
  const updated = source.replace(/^.*$/gm, (line) => {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line.trimEnd());
    if (header) inSharedPackage = header[1].replaceAll(/\s/g, '') === 'workspace.package';
    else if (/^\s*\[/.test(line)) inSharedPackage = false;
    if (!inSharedPackage) return line;
    return line.replace(/^(\s*version\s*=\s*)(["'])([^"']+)\2/, (_match, prefix: string, quote: string) => {
      replacements++;
      return `${prefix}${quote}${version}${quote}`;
    });
  });
  if (replacements !== 1 || sharedVersion(parse(updated)) !== version) {
    throw new Error('Expected one version assignment in launcher Cargo.toml [workspace.package].');
  }
  return updated;
}

export function syncLauncherVersion(workspaceRoot: string): void {
  const directory = path.join(workspaceRoot, 'launcher');
  const file = path.join(directory, 'Cargo.toml');
  const source = readFileSync(file, 'utf8');
  const manifest = parse(source);
  const version = launcherVersion(workspaceRoot);
  const packages = workspacePackages(directory, manifest);
  const previousVersion = sharedVersion(manifest);
  if (previousVersion === version) {
    try {
      assertLockVersions(path.join(directory, 'Cargo.lock'), packages, version);
      return;
    } catch {
      // Retry Cargo when an earlier sync wrote the manifest but could not update its lockfile.
    }
  } else {
    writeFileSync(file, replaceSharedVersion(source, version));
  }
  // The cwd also selects launcher's pinned rust-toolchain.toml. Never update external dependencies.
  try {
    new ProcessRunner().run('cargo', ['update', '--workspace', '--offline'], directory);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `Cargo sync uses the local dependency cache. Run cargo fetch in ${directory}, then retry vp run launcher:version:sync.`,
      { cause: error },
    );
  }
  checkLauncherVersion(workspaceRoot);
}
