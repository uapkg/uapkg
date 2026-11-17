import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { writeJson } from '../../../packages/uapkg/build/EnginePackage.ts';
import {
  PLATFORMS,
  archiveDirectory,
  artifactName,
  assembleRelease,
  inspectArtifact,
  platformForRuntime,
  platformForRustTarget,
  safeEngineCommand,
  selectNativeCandidates,
  type ReleaseBuild,
} from '../ReleaseArtifacts.ts';
import { parseOptions } from '../runRelease.ts';

const temporaryDirectories: string[] = [];
function temporary(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'uapkg-release-test-'));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function releaseFixture(): { input: string; output: string } {
  const root = temporary();
  const input = path.join(root, 'incoming');
  const output = path.join(root, 'complete');
  for (const platform of PLATFORMS) {
    const directory = path.join(input, platform);
    mkdirSync(directory, { recursive: true });
    const metadata: ReleaseBuild = { schemaVersion: 1, product: 'cli', version: '2.3.4', artifacts: [] };
    for (const kind of ['cli'] as const) {
      const file = path.join(directory, artifactName(kind, '2.3.4', platform));
      writeFileSync(file, `${kind}:${platform}`);
      metadata.artifacts.push(inspectArtifact(file, platform));
    }
    writeJson(path.join(directory, `build-${platform}.json`), metadata);
  }
  return { input, output };
}

describe('release catalog', () => {
  it('assembles only the seven CLI artifacts', () => {
    const { input, output } = releaseFixture();
    const catalog = assembleRelease(input, output, 'cli', '2.3.4');
    expect(catalog.artifacts).toHaveLength(7);
    expect(catalog.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(output, 'build.json'), 'utf8'))).toEqual(catalog);
  });

  it('refuses incomplete, altered, or mixed-version build results', () => {
    const { input, output } = releaseFixture();
    const file = path.join(input, 'linux-x64', artifactName('cli', '2.3.4', 'linux-x64'));
    writeFileSync(file, 'changed after platform verification');
    expect(() => assembleRelease(input, output, 'cli', '2.3.4')).toThrow('differs from build metadata');
    rmSync(file);
    expect(() => assembleRelease(input, output, 'cli', '2.3.4')).toThrow('Missing release artifact');
    expect(() => assembleRelease(input, output, 'cli', '2.3.5')).toThrow('Release identity differs');
  });

  it('rejects version ranges and path-like versions before choosing artifact names', () => {
    for (const version of ['latest', '^1.2.3', '1.2', '../1.2.3', '01.2.3', '1.2.3-01', 'v1.2.3']) {
      expect(() => artifactName('cli', version, 'win-x64')).toThrow('exact version');
    }
  });

  it('preserves explicit prereleases and build metadata in artifact names', () => {
    expect(artifactName('cli', '1.2.3-beta.1+build.2', 'win-x64')).toBe(
      'uapkg-cli-1.2.3-beta.1+build.2-win-x64.tar.gz',
    );
  });
});

describe('native archive and descriptor', () => {
  it('maps Node OS/CPU/libc independently from upstream package identifiers', () => {
    expect(platformForRuntime('win32', 'x64')).toBe('win-x64');
    expect(platformForRuntime('win32', 'arm64')).toBe('win-arm64');
    expect(platformForRuntime('linux', 'x64', { header: { glibcVersionRuntime: '2.28' } })).toBe('linux-x64');
    expect(platformForRuntime('linux', 'arm64', { header: { glibcVersionRuntime: '2.28' } })).toBe('linux-arm64');
    const musl = { sharedObjects: ['/lib/ld-musl-x86_64.so.1'] };
    expect(platformForRuntime('linux', 'x64', musl)).toBe('linux-x64-musl');
    expect(() => platformForRuntime('linux', 'arm64', musl)).toThrow('Unsupported release platform');
    expect(() => platformForRuntime('win32', 'ia32')).toThrow('Unsupported release platform');
    expect(() => platformForRuntime('linux', 'x64', {})).toThrow('Cannot identify');
    expect(() => platformForRuntime('linux', 'x64', { ...musl, header: { glibcVersionRuntime: '2.28' } })).toThrow(
      'Cannot identify',
    );
  });

  it('identifies launcher artifacts from the explicit Rust compilation target', () => {
    expect(platformForRustTarget('x86_64-unknown-linux-musl')).toBe('linux-x64-musl');
    expect(platformForRustTarget('x86_64-unknown-linux-gnu')).toBe('linux-x64');
    expect(platformForRustTarget('x86_64-pc-windows-msvc')).toBe('win-x64');
    expect(platformForRustTarget('aarch64-pc-windows-msvc')).toBe('win-arm64');
    for (const target of ['i686-pc-windows-msvc', 'aarch64-unknown-linux-musl', 'toString'])
      expect(() => platformForRustTarget(target)).toThrow('Unsupported launcher target');
    expect(parseOptions(['build-launcher', '--target', 'x86_64-unknown-linux-musl']).values.get('--target')).toBe(
      'x86_64-unknown-linux-musl',
    );
  });
  it('writes deterministic archives without using filesystem timestamps', async () => {
    const root = temporary();
    const source = path.join(root, 'source');
    mkdirSync(source);
    writeFileSync(path.join(source, 'file.txt'), 'same bytes');
    await archiveDirectory(source, path.join(root, 'first.tar.gz'));
    await archiveDirectory(source, path.join(root, 'second.tar.gz'));
    expect(readFileSync(path.join(root, 'first.tar.gz'))).toEqual(readFileSync(path.join(root, 'second.tar.gz')));
  });

  it('allows relative engine paths and rejects escapes', () => {
    const root = temporary();
    writeFileSync(path.join(root, 'node'), 'runtime');
    writeFileSync(path.join(root, 'entry.js'), 'engine');
    const descriptor = {
      schemaVersion: 1,
      version: '1.2.3',
      platform: 'linux-x64',
      kind: 'node',
      executable: 'node',
      args: ['entry.js'],
    } as const;
    const valid = { ...descriptor, args: [...descriptor.args] };
    expect(safeEngineCommand(root, valid)).toEqual({
      executable: path.join(root, 'node'),
      args: [path.join(root, 'entry.js')],
    });
    expect(() => safeEngineCommand(root, { ...valid, executable: '../node' })).toThrow('inside its directory');
    expect(() => safeEngineCommand(root, { ...valid, args: ['/tmp/entry.js'] })).toThrow('inside its directory');
  });

  it('rejects missing, duplicate, and unknown release options', () => {
    expect(() => parseOptions(['build-native', '--launcher'])).toThrow('Invalid release option');
    expect(() => parseOptions(['assemble', '--input', 'a', '--input', 'b'])).toThrow('Invalid release option');
    expect(() => parseOptions(['prepare-npm', '--unknown', 'value'])).toThrow('Invalid release option');
    expect(parseOptions(['smoke-npm', '--npm-version', '11.12.1', '--keyring']).keyring).toBe(true);
  });
});

describe('seven-platform packaging gate', () => {
  function candidates(): { input: string; output: string } {
    const { input, output } = releaseFixture();
    for (const format of ['node', 'sea'] as const) {
      for (const platform of PLATFORMS) {
        const directory = path.join(input, `candidate-${format}-${platform}`);
        mkdirSync(directory);
        const metadata: ReleaseBuild = {
          schemaVersion: 1,
          product: 'cli',
          version: '2.3.4',
          engineFormat: format,
          artifacts: [],
        };
        for (const kind of ['cli'] as const) {
          const file = path.join(directory, artifactName(kind, '2.3.4', platform));
          writeFileSync(file, `${format}:${kind}:${platform}`);
          metadata.artifacts.push(inspectArtifact(file, platform));
        }
        writeJson(path.join(directory, `build-${platform}.json`), metadata);
      }
    }
    return { input, output };
  }

  it('selects SEA only when all seven native candidates qualify', () => {
    const { input, output } = candidates();
    expect(selectNativeCandidates(input, output, '2.3.4').selectedFormat).toBe('sea');
    expect(assembleRelease(output, output, 'cli', '2.3.4').artifacts).toHaveLength(7);
    expect(readFileSync(path.join(output, artifactName('cli', '2.3.4', 'linux-x64')), 'utf8')).toBe(
      'sea:cli:linux-x64',
    );
  });

  it('uses node on every platform when one SEA candidate is missing or altered', () => {
    const { input, output } = candidates();
    rmSync(path.join(input, 'candidate-sea-darwin-arm64', 'build-darwin-arm64.json'));
    writeFileSync(path.join(input, 'candidate-sea-win-arm64', artifactName('cli', '2.3.4', 'win-arm64')), 'altered');
    const evidence = selectNativeCandidates(input, output, '2.3.4');
    expect(evidence.selectedFormat).toBe('node');
    expect(evidence.sea.filter((candidate) => !candidate.qualified)).toHaveLength(2);
    for (const platform of PLATFORMS)
      expect(readFileSync(path.join(output, artifactName('cli', '2.3.4', platform)), 'utf8')).toBe(
        `node:cli:${platform}`,
      );
  });

  it('falls back collectively when only the musl SEA is unavailable and refuses a missing musl Node fallback', () => {
    const { input, output } = candidates();
    rmSync(path.join(input, 'candidate-sea-linux-x64-musl', 'build-linux-x64-musl.json'));
    const evidence = selectNativeCandidates(input, output, '2.3.4');
    expect(evidence.selectedFormat).toBe('node');
    expect(evidence.sea.filter((candidate) => !candidate.qualified).map((candidate) => candidate.platform)).toEqual([
      'linux-x64-musl',
    ]);
    rmSync(path.join(input, 'candidate-node-linux-x64-musl', artifactName('cli', '2.3.4', 'linux-x64-musl')));
    expect(() => selectNativeCandidates(input, output, '2.3.4')).toThrow();
  });

  it('rejects an altered fallback and excludes mixed-version SEA candidates', () => {
    const { input, output } = candidates();
    const metadataPath = path.join(input, 'candidate-sea-linux-arm64', 'build-linux-arm64.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    metadata.version = '2.3.5';
    writeJson(metadataPath, metadata);
    writeFileSync(
      path.join(input, 'candidate-node-linux-arm64', artifactName('cli', '2.3.4', 'linux-arm64')),
      'bad fallback',
    );
    expect(() => selectNativeCandidates(input, output, '2.3.4')).toThrow('Changed node/linux-arm64');
  });
});
