import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { writeJson } from '../../../packages/uapkg/build/EnginePackage.ts';
import {
  ARTIFACT_KINDS,
  PLATFORMS,
  archiveDirectory,
  artifactName,
  assembleCatalog,
  inspectArtifact,
  safeEngineCommand,
  selectNativeCandidates,
  type ReleaseCatalog,
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
    const metadata: ReleaseCatalog = { schemaVersion: 1, cliVersion: '2.3.4', launcherVersion: '0.1.0', artifacts: [] };
    for (const kind of ARTIFACT_KINDS) {
      const file = path.join(directory, artifactName(kind, kind === 'launcher' ? '0.1.0' : '2.3.4', platform));
      writeFileSync(file, `${kind}:${platform}`);
      metadata.artifacts.push(inspectArtifact(file, kind, platform));
    }
    writeJson(path.join(directory, `release-${platform}.json`), metadata);
  }
  return { input, output };
}

describe('release catalog', () => {
  it('assembles all eighteen artifacts, preserving independent launcher versions', () => {
    const { input, output } = releaseFixture();
    const catalog = assembleCatalog(input, output, '2.3.4', '0.1.0');
    expect(catalog.artifacts).toHaveLength(18);
    expect(catalog.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(output, 'release.json'), 'utf8'))).toEqual(catalog);
  });

  it('refuses incomplete, altered, or mixed-version build results', () => {
    const { input, output } = releaseFixture();
    const file = path.join(input, 'linux-x64', artifactName('cli', '2.3.4', 'linux-x64'));
    writeFileSync(file, 'changed after platform verification');
    expect(() => assembleCatalog(input, output, '2.3.4', '0.1.0')).toThrow('differs from build metadata');
    rmSync(file);
    expect(() => assembleCatalog(input, output, '2.3.4', '0.1.0')).toThrow('Missing release artifact');
    expect(() => assembleCatalog(input, output, '2.3.5', '0.1.0')).toThrow('Release versions differ');
  });

  it('rejects version ranges and path-like versions before choosing artifact names', () => {
    for (const version of ['latest', '^1.2.3', '1.2', '../1.2.3', '01.2.3', '1.2.3-01', 'v1.2.3']) {
      expect(() => artifactName('cli', version, 'win32-x64')).toThrow('exact version');
    }
  });

  it('preserves explicit prereleases and build metadata in artifact names', () => {
    expect(artifactName('cli', '1.2.3-beta.1+build.2', 'win32-x64')).toBe(
      'uapkg-cli-1.2.3-beta.1+build.2-win32-x64.tar.gz',
    );
  });
});

describe('native archive and descriptor', () => {
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

describe('six-platform packaging gate', () => {
  function candidates(): { input: string; output: string } {
    const { input, output } = releaseFixture();
    for (const format of ['node', 'sea'] as const) {
      for (const platform of PLATFORMS) {
        const directory = path.join(input, `candidate-${format}-${platform}`);
        mkdirSync(directory);
        const metadata: ReleaseCatalog & { engineFormat: string } = {
          schemaVersion: 1,
          cliVersion: '2.3.4',
          launcherVersion: '0.1.0',
          engineFormat: format,
          artifacts: [],
        };
        for (const kind of ARTIFACT_KINDS) {
          const file = path.join(directory, artifactName(kind, kind === 'launcher' ? '0.1.0' : '2.3.4', platform));
          writeFileSync(file, `${format}:${kind}:${platform}`);
          metadata.artifacts.push(inspectArtifact(file, kind, platform));
        }
        writeJson(path.join(directory, `release-${platform}.json`), metadata);
      }
    }
    return { input, output };
  }

  it('selects SEA only when all six native candidates qualify', () => {
    const { input, output } = candidates();
    expect(selectNativeCandidates(input, output, '2.3.4', '0.1.0').selectedFormat).toBe('sea');
    expect(assembleCatalog(output, output, '2.3.4', '0.1.0').artifacts).toHaveLength(18);
    expect(readFileSync(path.join(output, artifactName('cli', '2.3.4', 'linux-x64')), 'utf8')).toBe(
      'sea:cli:linux-x64',
    );
  });

  it('uses node on every platform when one SEA candidate is missing or altered', () => {
    const { input, output } = candidates();
    rmSync(path.join(input, 'candidate-sea-darwin-arm64', 'release-darwin-arm64.json'));
    writeFileSync(
      path.join(input, 'candidate-sea-win32-arm64', artifactName('cli', '2.3.4', 'win32-arm64')),
      'altered',
    );
    const evidence = selectNativeCandidates(input, output, '2.3.4', '0.1.0');
    expect(evidence.selectedFormat).toBe('node');
    expect(evidence.sea.filter((candidate) => !candidate.qualified)).toHaveLength(2);
    for (const platform of PLATFORMS)
      expect(readFileSync(path.join(output, artifactName('cli', '2.3.4', platform)), 'utf8')).toBe(
        `node:cli:${platform}`,
      );
  });

  it('rejects an altered fallback and excludes mixed-version SEA candidates', () => {
    const { input, output } = candidates();
    const metadataPath = path.join(input, 'candidate-sea-linux-arm64', 'release-linux-arm64.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    metadata.cliVersion = '2.3.5';
    writeJson(metadataPath, metadata);
    writeFileSync(
      path.join(input, 'candidate-node-linux-arm64', artifactName('bundle', '2.3.4', 'linux-arm64')),
      'bad fallback',
    );
    expect(() => selectNativeCandidates(input, output, '2.3.4', '0.1.0')).toThrow('Changed node/linux-arm64/bundle');
  });
});
