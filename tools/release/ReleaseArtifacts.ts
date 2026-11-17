import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { CLI_ROOT, readJson, writeJson } from '../../packages/uapkg/build/EnginePackage.ts';
import {
  PLATFORMS,
  artifactName,
  assertExactVersion,
  type ReleasePlatform,
  type CurrentReleasePlatform,
  type ReleaseProduct,
} from './ReleaseContract.ts';
export {
  PLATFORMS,
  artifactName,
  assertExactVersion,
  type ReleasePlatform,
  type ReleaseProduct,
} from './ReleaseContract.ts';

export interface ReleaseArtifact {
  platform: ReleasePlatform;
  fileName: string;
  sha256: string;
  size: number;
}
/** Internal build evidence only; never served as a client release descriptor. */
export interface ReleaseBuild {
  schemaVersion: 1;
  product: ReleaseProduct;
  version: string;
  artifacts: ReleaseArtifact[];
  engineFormat?: 'node' | 'sea';
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

interface RuntimeReport {
  header?: { glibcVersionRuntime?: string };
  sharedObjects?: string[];
}

/** Node and npm keep their win32 name; only UAPKG distribution identities use win. */
export function platformForRuntime(os: string, arch: string, report?: RuntimeReport): CurrentReleasePlatform {
  let platform = `${os === 'win32' ? 'win' : os}-${arch}`;
  if (os === 'linux') {
    const glibc = Boolean(report?.header?.glibcVersionRuntime);
    const musl = report?.sharedObjects?.some((library) => /(?:^|\/)ld-musl-[^/]+\.so\.1$/.test(library)) ?? false;
    if (glibc === musl) throw new Error('Cannot identify the Linux runtime libc from its Node diagnostic report.');
    if (musl) platform += '-musl';
  }
  if (!(PLATFORMS as readonly string[]).includes(platform))
    throw new Error(`Unsupported release platform ${platform}.`);
  return platform as CurrentReleasePlatform;
}

export function currentPlatform(): CurrentReleasePlatform {
  const report = process.platform === 'linux' ? process.report?.getReport() : undefined;
  return platformForRuntime(process.platform, process.arch, report as RuntimeReport | undefined);
}

export function platformForRustTarget(target: string): CurrentReleasePlatform {
  const platforms: Record<string, CurrentReleasePlatform> = {
    'x86_64-pc-windows-msvc': 'win-x64',
    'aarch64-pc-windows-msvc': 'win-arm64',
    'x86_64-apple-darwin': 'darwin-x64',
    'aarch64-apple-darwin': 'darwin-arm64',
    'x86_64-unknown-linux-gnu': 'linux-x64',
    'aarch64-unknown-linux-gnu': 'linux-arm64',
    'x86_64-unknown-linux-musl': 'linux-x64-musl',
  };
  if (!Object.hasOwn(platforms, target)) throw new Error(`Unsupported launcher target ${target}.`);
  return platforms[target]!;
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

export function inspectArtifact(file: string, platform: ReleasePlatform): ReleaseArtifact {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular artifact file: ${file}`);
  return {
    platform,
    fileName: path.basename(file),
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    size: info.size,
  };
}

export function assembleRelease(input: string, output: string, product: ReleaseProduct, version: string): ReleaseBuild {
  assertExactVersion(version);
  const source = path.resolve(input);
  const destination = path.resolve(output);
  const files = readdirSync(source, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  const candidateFiles = new Map<string, string>();
  for (const entry of files.filter((entry) => entry.name.endsWith('.tar.gz'))) {
    if (candidateFiles.has(entry.name)) throw new Error(`Duplicate release artifact ${entry.name}.`);
    candidateFiles.set(entry.name, path.join(entry.parentPath, entry.name));
  }
  const build: ReleaseBuild = { schemaVersion: 1, product, version, artifacts: [] };
  for (const platform of PLATFORMS) {
    const metadataFiles = files.filter((entry) => entry.name === `build-${platform}.json`);
    if (metadataFiles.length !== 1) throw new Error(`Expected one build record for ${platform}.`);
    const record = metadataFiles[0]!;
    const metadata = readJson<ReleaseBuild>(path.join(record.parentPath, record.name));
    if (
      metadata.schemaVersion !== 1 ||
      metadata.product !== product ||
      metadata.version !== version ||
      metadata.artifacts.length !== 1
    )
      throw new Error(`Release identity differs for ${platform}.`);
    const name = artifactName(product, version, platform);
    const file = candidateFiles.get(name);
    if (!file) throw new Error(`Missing release artifact ${name}.`);
    const artifact = inspectArtifact(file, platform);
    const recorded = metadata.artifacts[0]!;
    if (
      recorded.platform !== platform ||
      recorded.fileName !== name ||
      recorded.sha256 !== artifact.sha256 ||
      recorded.size !== artifact.size
    )
      throw new Error(`Artifact differs from build metadata: ${name}.`);
    build.artifacts.push(artifact);
    candidateFiles.delete(name);
  }
  if (candidateFiles.size) throw new Error(`Unexpected artifacts: ${[...candidateFiles.keys()].join(', ')}`);
  mkdirSync(destination, { recursive: true });
  for (const artifact of build.artifacts) {
    const record = files.find((entry) => entry.name === artifact.fileName)!;
    const file = path.join(record.parentPath, record.name);
    if (path.resolve(file) !== path.join(destination, artifact.fileName))
      cpSync(file, path.join(destination, artifact.fileName));
  }
  writeJson(path.join(destination, 'build.json'), build);
  return build;
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
  sea: CandidateStatus[];
}

function validateCandidate(
  directory: string,
  format: 'node' | 'sea',
  platform: ReleasePlatform,
  version: string,
): ReleaseBuild {
  const metadata = readJson<ReleaseBuild>(path.join(directory, `build-${platform}.json`));
  if (
    metadata.schemaVersion !== 1 ||
    metadata.product !== 'cli' ||
    metadata.engineFormat !== format ||
    metadata.version !== version
  )
    throw new Error(`Candidate identity differs for ${format}/${platform}.`);
  const name = artifactName('cli', version, platform);
  if (
    !Array.isArray(metadata.artifacts) ||
    metadata.artifacts.length !== 1 ||
    metadata.artifacts[0]!.fileName !== name ||
    metadata.artifacts[0]!.platform !== platform
  )
    throw new Error(`Incomplete ${format}/${platform} candidate.`);
  const actual = inspectArtifact(path.join(directory, name), platform);
  const expected = metadata.artifacts[0]!;
  if (actual.sha256 !== expected.sha256 || actual.size !== expected.size)
    throw new Error(`Changed ${format}/${platform} artifact.`);
  return metadata;
}

/** Qualify SEA collectively; never mix engine formats across one release. */
export function selectNativeCandidates(input: string, output: string, cliVersion: string): PackagingEvidence {
  assertExactVersion(cliVersion);
  const source = path.resolve(input);
  const destination = path.resolve(output);
  if (source === destination || source.startsWith(`${destination}${path.sep}`))
    throw new Error('Selected artifacts need a separate output directory.');
  const sea: CandidateStatus[] = PLATFORMS.map((platform) => {
    try {
      validateCandidate(path.join(source, `candidate-sea-${platform}`), 'sea', platform, cliVersion);
      return { platform, qualified: true };
    } catch (error) {
      return { platform, qualified: false, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  const selectedFormat = sea.every((candidate) => candidate.qualified) ? 'sea' : 'node';
  const selected = PLATFORMS.map((platform) => {
    const directory = path.join(source, `candidate-${selectedFormat}-${platform}`);
    return { directory, platform, metadata: validateCandidate(directory, selectedFormat, platform, cliVersion) };
  });
  mkdirSync(destination, { recursive: true });
  for (const candidate of selected) {
    for (const artifact of candidate.metadata.artifacts)
      cpSync(path.join(candidate.directory, artifact.fileName), path.join(destination, artifact.fileName));
    cpSync(
      path.join(candidate.directory, `build-${candidate.platform}.json`),
      path.join(destination, `build-${candidate.platform}.json`),
    );
  }
  const evidence: PackagingEvidence = { schemaVersion: 1, selectedFormat, cliVersion, sea };
  writeJson(path.join(destination, 'packaging-evidence.json'), evidence);
  return evidence;
}
