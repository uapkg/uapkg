import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vite-plus/test';
import { ProcessRunner } from '../../dev-build/ProcessRunner.ts';
import { checkLauncherVersion, readLauncherCargoVersion, syncLauncherVersion } from '../LauncherVersion.ts';

const roots: string[] = [];
let run: MockInstance<ProcessRunner['run']>;

beforeEach(() => {
  run = vi.spyOn(ProcessRunner.prototype, 'run').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const externalLock = `
[[package]]
name = "external"
version = "1.2.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "unchanged"
`;

function lock(version: string): string {
  return `version = 4

[[package]]
name = "uapkg-launcher"
version = "${version}"
dependencies = ["uapkg-slim-config"]

[[package]]
name = "uapkg-slim-config"
version = "${version}"
${externalLock}`;
}

function fixture(version = '0.3.3') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'uapkg-launcher-version-'));
  roots.push(root);
  const directory = path.join(root, 'launcher');
  const crate = path.join(directory, 'crates/slim-config');
  mkdirSync(crate, { recursive: true });
  const manifest = path.join(directory, 'Cargo.toml');
  const lockfile = path.join(directory, 'Cargo.lock');
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'uapkg-launcher', version, private: true }),
  );
  writeFileSync(
    manifest,
    `[package]
name = "uapkg-launcher"
version.workspace = true

[dependencies]
external = { version = "9.9.9" }

[workspace]
members = ["crates/slim-config"]

[workspace.package]
version = "0.3.3" # shared release

[dev-dependencies]
unrelated = { version = "8.8.8" }
`,
  );
  writeFileSync(path.join(crate, 'Cargo.toml'), '[package]\nname = "uapkg-slim-config"\nversion.workspace = true\n');
  writeFileSync(lockfile, lock('0.3.3'));
  return { root, directory, crate, manifest, lockfile };
}

describe('launcher release version', () => {
  it('reads the shared version rather than dependency versions, without running Cargo', () => {
    const { root } = fixture();
    expect(readLauncherCargoVersion(root)).toBe('0.3.3');
    expect(() => checkLauncherVersion(root)).not.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['not-a-version', 'v0.3.3', '0.3', ''])('rejects an invalid shared version %j', (version) => {
    const { root, manifest } = fixture();
    writeFileSync(manifest, `[workspace.package]\nversion = "${version}"\n`);
    expect(() => readLauncherCargoVersion(root)).toThrow('exact version');
  });

  it('rejects a missing shared version instead of reading an unrelated version', () => {
    const { root, manifest } = fixture();
    writeFileSync(manifest, '[workspace.package]\nlicense = "MIT"\n[dependencies]\nversion = "9.9.9"\n');
    expect(() => readLauncherCargoVersion(root)).toThrow('exact version');
  });

  it('checks manifest and lockfile drift without modifying files', () => {
    const { root, manifest, lockfile } = fixture('0.3.4');
    const before = [readFileSync(manifest), readFileSync(lockfile)];
    expect(() => checkLauncherVersion(root)).toThrow('launcher:version:sync');
    expect([readFileSync(manifest), readFileSync(lockfile)]).toEqual(before);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects stale or missing workspace lock entries', () => {
    const { root, lockfile } = fixture();
    writeFileSync(lockfile, lock('0.3.2'));
    expect(() => checkLauncherVersion(root)).toThrow('Cargo.lock is stale');
    writeFileSync(lockfile, `version = 4\n${externalLock}`);
    expect(() => checkLauncherVersion(root)).toThrow('uapkg-launcher');
  });

  it('requires private launcher metadata', () => {
    const { root, directory } = fixture();
    writeFileSync(path.join(directory, 'package.json'), '{"name":"uapkg-launcher","version":"0.3.3"}');
    expect(() => checkLauncherVersion(root)).toThrow('private');
  });

  it('rejects crates with explicit versions even when their version matches', () => {
    const { root, crate } = fixture();
    writeFileSync(path.join(crate, 'Cargo.toml'), '[package]\nname = "uapkg-slim-config"\nversion = "0.3.3"\n');
    expect(() => checkLauncherVersion(root)).toThrow('version.workspace = true');
    expect(() => syncLauncherVersion(root)).toThrow('version.workspace = true');
    expect(run).not.toHaveBeenCalled();
  });

  it('checks members selected by a workspace glob', () => {
    const { root, manifest, directory } = fixture();
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('crates/slim-config', 'crates/*'));
    const other = path.join(directory, 'crates/other');
    mkdirSync(other);
    writeFileSync(path.join(other, 'Cargo.toml'), '[package]\nname = "other"\nversion = "0.3.3"\n');
    expect(() => checkLauncherVersion(root)).toThrow('version.workspace = true');
  });

  it.each([
    'dependencies',
    'build-dependencies',
    'dev-dependencies',
    "target.'cfg(windows)'.dependencies",
    "target.'cfg(windows)'.build-dependencies",
    "target.'cfg(windows)'.dev-dependencies",
  ])('checks implicit workspace members from %s', (section) => {
    const { root, directory, crate } = fixture();
    const implicit = path.join(directory, 'crates/implicit');
    mkdirSync(implicit);
    writeFileSync(path.join(implicit, 'Cargo.toml'), '[package]\nname = "implicit"\nversion = "0.3.3"\n');
    const memberManifest = path.join(crate, 'Cargo.toml');
    writeFileSync(
      memberManifest,
      `${readFileSync(memberManifest, 'utf8')}\n[${section}]\nimplicit = { path = "../implicit" }\n`,
    );
    expect(() => checkLauncherVersion(root)).toThrow('version.workspace = true');
    expect(() => syncLauncherVersion(root)).toThrow('version.workspace = true');
    expect(run).not.toHaveBeenCalled();
  });

  it('resolves inherited path dependencies relative to the workspace root', () => {
    const { root, directory, crate, manifest } = fixture();
    const implicit = path.join(directory, 'crates/implicit');
    mkdirSync(implicit);
    writeFileSync(path.join(implicit, 'Cargo.toml'), '[package]\nname = "implicit"\nversion = "0.3.3"\n');
    writeFileSync(
      manifest,
      `${readFileSync(manifest, 'utf8')}\n[workspace.dependencies]\ninherited = { path = "crates/implicit" }\n`,
    );
    const memberManifest = path.join(crate, 'Cargo.toml');
    writeFileSync(
      memberManifest,
      `${readFileSync(memberManifest, 'utf8')}\n[dependencies]\ninherited = { workspace = true }\n`,
    );
    expect(() => checkLauncherVersion(root)).toThrow('version.workspace = true');
  });

  it('accepts inherited registry dependency versions', () => {
    const { root, crate, manifest } = fixture();
    writeFileSync(manifest, `${readFileSync(manifest, 'utf8')}\n[workspace.dependencies]\nexternal = "1.2.3"\n`);
    const memberManifest = path.join(crate, 'Cargo.toml');
    writeFileSync(
      memberManifest,
      `${readFileSync(memberManifest, 'utf8')}\n[dependencies]\nexternal = { workspace = true }\n`,
    );
    expect(() => checkLauncherVersion(root)).not.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['crates/independent', 'crates/indepen*'])('skips implicit path members excluded by %s', (exclude) => {
    const { root, directory, crate, manifest } = fixture();
    const independent = path.join(directory, 'crates/independent');
    mkdirSync(independent);
    writeFileSync(path.join(independent, 'Cargo.toml'), '[package]\nname = "independent"\nversion = "9.0.0"\n');
    writeFileSync(
      manifest,
      readFileSync(manifest, 'utf8').replace('[workspace]', `[workspace]\nexclude = ["${exclude}"]`),
    );
    const memberManifest = path.join(crate, 'Cargo.toml');
    writeFileSync(
      memberManifest,
      `${readFileSync(memberManifest, 'utf8')}\n[dependencies]\nindependent = { path = "../independent" }\n`,
    );
    expect(() => checkLauncherVersion(root)).not.toThrow();
    syncLauncherVersion(root);
    expect(run).not.toHaveBeenCalled();
  });

  it('checks lockfile versions for implicit workspace members', () => {
    const { root, directory, crate, lockfile } = fixture();
    const implicit = path.join(directory, 'crates/implicit');
    mkdirSync(implicit);
    writeFileSync(path.join(implicit, 'Cargo.toml'), '[package]\nname = "implicit"\nversion.workspace = true\n');
    const memberManifest = path.join(crate, 'Cargo.toml');
    writeFileSync(
      memberManifest,
      `${readFileSync(memberManifest, 'utf8')}\n[dependencies]\nimplicit = { path = "../implicit" }\n`,
    );
    writeFileSync(lockfile, `${lock('0.3.3')}\n[[package]]\nname = "implicit"\nversion = "0.3.2"\n`);
    expect(() => checkLauncherVersion(root)).toThrow('Cargo.lock is stale for implicit');
  });

  it('copies the Changesets version, preserving comments, CRLF and unrelated versions', () => {
    const { root, directory, manifest, lockfile } = fixture('0.3.4');
    const before = readFileSync(manifest, 'utf8').replaceAll('\n', '\r\n');
    writeFileSync(manifest, before);
    run.mockImplementation(() => {
      expect(readLauncherCargoVersion(root)).toBe('0.3.4');
      writeFileSync(lockfile, lock('0.3.4'));
    });
    syncLauncherVersion(root);
    expect(readFileSync(manifest, 'utf8')).toBe(before.replace('version = "0.3.3"', 'version = "0.3.4"'));
    expect(readFileSync(lockfile, 'utf8')).toContain(externalLock);
    expect(run).toHaveBeenCalledExactlyOnceWith('cargo', ['update', '--workspace', '--offline'], directory);
    expect(() => checkLauncherVersion(root)).not.toThrow();
  });

  it('does not rewrite synchronized files or require Cargo for a CLI-only version change', () => {
    const { root, manifest, lockfile } = fixture();
    for (const file of [manifest, lockfile]) utimesSync(file, new Date(1_000), new Date(1_000));
    syncLauncherVersion(root);
    expect(run).not.toHaveBeenCalled();
    for (const file of [manifest, lockfile]) expect(statSync(file).mtimeMs).toBe(1_000);
  });

  it('recovers from Cargo failure after the manifest has already been synchronized', () => {
    const { root, manifest, lockfile } = fixture('0.3.4');
    run.mockImplementationOnce(() => {
      throw new Error('Cargo unavailable');
    });
    expect(() => syncLauncherVersion(root)).toThrow('Cargo unavailable');
    run.mockImplementationOnce(() => {
      throw new Error('Cargo dependency cache unavailable');
    });
    expect(() => syncLauncherVersion(root)).toThrow('Run cargo fetch');
    expect(readLauncherCargoVersion(root)).toBe('0.3.4');
    expect(() => checkLauncherVersion(root)).toThrow('Cargo.lock is stale');
    const synchronized = readFileSync(manifest);
    run.mockImplementationOnce(() => writeFileSync(lockfile, lock('0.3.4')));
    syncLauncherVersion(root);
    expect(readFileSync(manifest)).toEqual(synchronized);
    expect(() => checkLauncherVersion(root)).not.toThrow();
  });
});
