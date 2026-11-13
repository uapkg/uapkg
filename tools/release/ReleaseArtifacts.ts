import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse } from 'semver';
import { CLI_ROOT, readJson, writeJson } from '../../packages/uapkg/build/EnginePackage.ts';

export const PLATFORMS = [
  'win32-x64',
  'win32-arm64',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
] as const;
export type ReleasePlatform = (typeof PLATFORMS)[number];
export const ARTIFACT_KINDS = ['cli', 'launcher', 'bundle'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface ReleaseArtifact {
  kind: ArtifactKind;
  platform: ReleasePlatform;
  fileName: string;
  sha256: string;
  size: number;
}

export interface ReleaseCatalog {
  schemaVersion: 1;
  cliVersion: string;
  launcherVersion: string;
  artifacts: ReleaseArtifact[];
}

export interface EngineDescriptor {
  schemaVersion: 1;
  version: string;
  platform: ReleasePlatform;
  kind: 'node' | 'sea';
  executable: string;
  args: string[];
}

const require = createRequire(path.join(CLI_ROOT, 'package.json'));
const tar = require('tar') as {
  create(
    options: {
      cwd: string;
      file: string;
      gzip: boolean;
      portable: boolean;
      mtime: Date;
      noMtime: boolean;
      follow: boolean;
    },
    files: string[],
  ): Promise<void>;
};

export function currentPlatform(): ReleasePlatform {
  const platform = `${process.platform}-${process.arch}`;
  if (!(PLATFORMS as readonly string[]).includes(platform))
    throw new Error(`Unsupported release platform ${platform}.`);
  return platform as ReleasePlatform;
}

export function assertExactVersion(value: string): void {
  const parsed = parse(value);
  const canonical = parsed && `${parsed.version}${parsed.build.length ? `+${parsed.build.join('.')}` : ''}`;
  if (canonical !== value) {
    throw new Error(`Expected an exact version, received ${JSON.stringify(value)}.`);
  }
}

export function artifactName(kind: ArtifactKind, version: string, platform: ReleasePlatform): string {
  assertExactVersion(version);
  return `uapkg-${kind}-${version}-${platform}.tar.gz`;
}

/** Archives contain files/directories only, matching the launcher's safe extractor. */
export async function archiveDirectory(directory: string, output: string): Promise<void> {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    const absolute = path.join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
      throw new Error(`Release archives cannot contain links or special files: ${absolute}`);
    }
    if (entry.isFile()) files.push(path.relative(directory, absolute).replaceAll('\\', '/'));
  }
  files.sort();
  mkdirSync(path.dirname(output), { recursive: true });
  await tar.create(
    { cwd: directory, file: output, gzip: true, portable: true, mtime: new Date(0), noMtime: true, follow: false },
    files,
  );
}

export function inspectArtifact(file: string, kind: ArtifactKind, platform: ReleasePlatform): ReleaseArtifact {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular artifact file: ${file}`);
  return {
    kind,
    platform,
    fileName: path.basename(file),
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    size: info.size,
  };
}

export function assembleCatalog(
  input: string,
  output: string,
  cliVersion: string,
  launcherVersion: string,
): ReleaseCatalog {
  assertExactVersion(cliVersion);
  assertExactVersion(launcherVersion);
  const source = path.resolve(input);
  const destination = path.resolve(output);
  const candidateFiles = new Map<string, string>();
  for (const entry of readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.tar.gz')) continue;
    if (candidateFiles.has(entry.name)) throw new Error(`Duplicate release artifact ${entry.name}.`);
    candidateFiles.set(entry.name, path.join(entry.parentPath, entry.name));
  }
  const catalog: ReleaseCatalog = { schemaVersion: 1, cliVersion, launcherVersion, artifacts: [] };
  mkdirSync(destination, { recursive: true });
  for (const platform of PLATFORMS) {
    const metadataFile = [...readdirSync(source, { recursive: true, withFileTypes: true })].find(
      (entry) => entry.isFile() && entry.name === `release-${platform}.json`,
    );
    if (!metadataFile) throw new Error(`Missing build metadata for ${platform}.`);
    const metadata = readJson<ReleaseCatalog>(path.join(metadataFile.parentPath, metadataFile.name));
    if (metadata.cliVersion !== cliVersion || metadata.launcherVersion !== launcherVersion) {
      throw new Error(`Release versions differ for ${platform}.`);
    }
    for (const kind of ARTIFACT_KINDS) {
      const fileName = artifactName(kind, kind === 'launcher' ? launcherVersion : cliVersion, platform);
      const file = candidateFiles.get(fileName);
      if (!file) throw new Error(`Missing release artifact ${fileName}.`);
      const artifact = inspectArtifact(file, kind, platform);
      const recorded = metadata.artifacts.find((item) => item.kind === kind && item.platform === platform);
      if (
        !recorded ||
        recorded.fileName !== fileName ||
        recorded.sha256 !== artifact.sha256 ||
        recorded.size !== artifact.size
      ) {
        throw new Error(`Artifact differs from build metadata: ${fileName}.`);
      }
      catalog.artifacts.push(artifact);
      const target = path.join(destination, fileName);
      if (path.resolve(file) !== target) cpSync(file, target);
      candidateFiles.delete(fileName);
    }
  }
  if (candidateFiles.size > 0) throw new Error(`Unexpected artifacts: ${[...candidateFiles.keys()].join(', ')}`);
  writeJson(path.join(destination, 'release.json'), catalog);
  return catalog;
}

export function safeEngineCommand(root: string, descriptor: EngineDescriptor): { executable: string; args: string[] } {
  const resolveEntry = (relative: string): string => {
    if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').includes('..')) {
      throw new Error(`Engine paths must stay inside its directory: ${relative}`);
    }
    const file = path.resolve(root, relative);
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`Engine file is missing: ${relative}`);
    return file;
  };
  if (descriptor.schemaVersion !== 1 || !['node', 'sea'].includes(descriptor.kind))
    throw new Error('Unsupported engine descriptor.');
  return { executable: resolveEntry(descriptor.executable), args: descriptor.args.map(resolveEntry) };
}

interface CandidateStatus {
  platform: ReleasePlatform;
  qualified: boolean;
  reason?: string;
}

export interface PackagingEvidence {
  schemaVersion: 1;
  selectedFormat: 'node' | 'sea';
  cliVersion: string;
  launcherVersion: string;
  sea: CandidateStatus[];
}

function validateCandidate(
  directory: string,
  format: 'node' | 'sea',
  platform: ReleasePlatform,
  cliVersion: string,
  launcherVersion: string,
): ReleaseCatalog {
  const metadata = readJson<ReleaseCatalog & { engineFormat: string }>(
    path.join(directory, `release-${platform}.json`),
  );
  if (
    metadata.schemaVersion !== 1 ||
    metadata.engineFormat !== format ||
    metadata.cliVersion !== cliVersion ||
    metadata.launcherVersion !== launcherVersion
  ) {
    throw new Error(`Candidate identity or versions differ for ${format}/${platform}.`);
  }
  if (!Array.isArray(metadata.artifacts) || metadata.artifacts.length !== ARTIFACT_KINDS.length)
    throw new Error(`Incomplete ${format}/${platform} candidate.`);
  for (const kind of ARTIFACT_KINDS) {
    const expectedName = artifactName(kind, kind === 'launcher' ? launcherVersion : cliVersion, platform);
    const expected = metadata.artifacts.find((artifact) => artifact.kind === kind && artifact.platform === platform);
    if (!expected || expected.fileName !== expectedName)
      throw new Error(`Missing ${kind} artifact for ${format}/${platform}.`);
    const actual = inspectArtifact(path.join(directory, expectedName), kind, platform);
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size)
      throw new Error(`Changed ${format}/${platform}/${kind} artifact.`);
  }
  return metadata;
}

/** Qualify SEA collectively; never mix engine formats across one release. */
export function selectNativeCandidates(
  input: string,
  output: string,
  cliVersion: string,
  launcherVersion: string,
): PackagingEvidence {
  assertExactVersion(cliVersion);
  assertExactVersion(launcherVersion);
  const source = path.resolve(input);
  const destination = path.resolve(output);
  if (source === destination || source.startsWith(`${destination}${path.sep}`))
    throw new Error('Selected artifacts need a separate output directory.');
  const sea: CandidateStatus[] = PLATFORMS.map((platform) => {
    try {
      validateCandidate(path.join(source, `candidate-sea-${platform}`), 'sea', platform, cliVersion, launcherVersion);
      return { platform, qualified: true };
    } catch (error) {
      return { platform, qualified: false, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  const selectedFormat = sea.every((candidate) => candidate.qualified) ? 'sea' : 'node';
  // Validate every selected artifact before copying anything into the release directory.
  const selected = PLATFORMS.map((platform) => {
    const directory = path.join(source, `candidate-${selectedFormat}-${platform}`);
    return {
      directory,
      platform,
      metadata: validateCandidate(directory, selectedFormat, platform, cliVersion, launcherVersion),
    };
  });
  mkdirSync(destination, { recursive: true });
  for (const candidate of selected) {
    for (const artifact of candidate.metadata.artifacts)
      cpSync(path.join(candidate.directory, artifact.fileName), path.join(destination, artifact.fileName));
    cpSync(
      path.join(candidate.directory, `release-${candidate.platform}.json`),
      path.join(destination, `release-${candidate.platform}.json`),
    );
  }
  const evidence: PackagingEvidence = { schemaVersion: 1, selectedFormat, cliVersion, launcherVersion, sea };
  writeJson(path.join(destination, 'packaging-evidence.json'), evidence);
  return evidence;
}
