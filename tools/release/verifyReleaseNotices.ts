import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { type Readable } from 'node:stream';
import { Version } from '@cyclonedx/cyclonedx-library/Spec';
import { JsonValidator } from '@cyclonedx/cyclonedx-library/Validation';
import { CLI_ROOT, readJson, runChecked } from '../../packages/uapkg/build/EnginePackage.ts';
import { hasDeclaredLicense, NOTICE_FILENAME, type SbomLicenseChoice } from '../../packages/uapkg/build/Notices.ts';
import { readLauncherCargoVersion } from '../launcher/LauncherVersion.ts';
import type { EngineDescriptor } from './ReleaseArtifacts.ts';
import { artifactName, PLATFORMS, type CurrentReleasePlatform } from './ReleaseContract.ts';

type Delivery = 'npm' | 'node' | 'sea' | 'launcher';
type ArchiveEntry = Readable & { path: string; type: string };
const tar = createRequire(path.join(CLI_ROOT, 'package.json'))('tar') as {
  list: (options: { file: string; strict: boolean; onentry: (entry: ArchiveEntry) => void }) => Promise<void>;
};
interface Component {
  name: string;
  group?: string;
  version?: string;
  licenses?: SbomLicenseChoice[];
  components?: Component[];
}

function packageName(component: Component): string {
  return component.group ? `${component.group}/${component.name}` : component.name;
}

function* walkComponents(components: Component[]): Generator<Component> {
  for (const component of components) {
    yield component;
    if (component.components) yield* walkComponents(component.components);
  }
}

export async function verifyNoticeDocument(text: string, delivery: Delivery, version: string) {
  const doc = JSON.parse(text) as {
    specVersion?: string;
    metadata?: { component?: Component };
    components?: Component[];
  };
  const schema = Object.values(Version).find((supported) => supported === doc.specVersion);
  if (!schema) throw new Error(`Unsupported CycloneDX version: ${doc.specVersion}.`);
  const errors = await new JsonValidator(schema).validate(text);
  if (errors) throw new Error(`Invalid CycloneDX document: ${JSON.stringify(errors)}`);
  const product = doc.metadata?.component;
  const name = delivery === 'launcher' ? 'uapkg-launcher' : '@uapkg/cli';
  if (!product || packageName(product) !== name || product.version !== version)
    throw new Error(`Expected an SBOM for ${name}@${version}.`);
  const dependencies = [...walkComponents([...(product.components ?? []), ...(doc.components ?? [])])];
  if (
    !dependencies.some(
      (component) => component.name.trim() && component.version?.trim() && packageName(component) !== name,
    )
  )
    throw new Error('The SBOM contains no versioned dependency components.');
  const missing = [product, ...dependencies]
    .filter((component) => !hasDeclaredLicense(component))
    .map((component) =>
      component.version ? `${packageName(component)}@${component.version}` : packageName(component),
    );
  if (missing.length) throw new Error(`Missing license declarations: ${[...new Set(missing)].join(', ')}.`);
}

/** Read only the expected file. Never extract archive-provided paths or links onto disk. */
async function member(archive: string, expected: string, singleExecutable: boolean): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let matches = 0;
  let entries = 0;
  let regular = false;
  await tar.list({
    file: archive,
    strict: true,
    onentry(entry) {
      entries++;
      if (entry.path !== expected) return;
      matches++;
      regular = entry.type === 'File';
      entry.on('data', (chunk: Buffer) => chunks.push(chunk));
    },
  });
  if (!regular || matches !== 1 || (singleExecutable && entries !== 1))
    throw new Error(`Expected ${singleExecutable ? 'only ' : 'one regular '}${expected} in ${path.basename(archive)}.`);
  return Buffer.concat(chunks);
}

export async function verifyArchiveNotices(
  archive: string,
  delivery: Delivery,
  version: string,
  target?: CurrentReleasePlatform,
) {
  if (delivery === 'launcher') {
    const name = target?.startsWith('win-') ? 'uapkg.exe' : 'uapkg';
    const binary = await member(archive, name, true);
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'uapkg-launcher-notices-'));
    try {
      const executable = path.join(scratch, name);
      writeFileSync(executable, binary, { mode: 0o755 });
      const output = runChecked(executable, ['launcher', '--license'], scratch, {
        ...process.env,
        HOME: scratch,
        USERPROFILE: scratch,
        UAPKG_OFFLINE: '1',
      });
      await verifyNoticeDocument(output, delivery, version);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  } else {
    const bytes = await member(archive, delivery === 'npm' ? 'package/' + NOTICE_FILENAME : NOTICE_FILENAME, false);
    await verifyNoticeDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes), delivery, version);
    if (delivery !== 'npm') {
      const descriptor = JSON.parse((await member(archive, 'engine.json', false)).toString('utf8')) as EngineDescriptor;
      if (descriptor.kind !== delivery || descriptor.platform !== target || descriptor.version !== version)
        throw new Error(`Expected ${delivery} engine ${version} for ${target}.`);
    }
  }
}

async function main(args: string[]) {
  const [delivery, file, platform] = args;
  const cliVersion = readJson<{ version: string }>(path.join(CLI_ROOT, 'package.json')).version;
  if (!file || !['npm', 'node', 'sea', 'launcher'].includes(delivery) || args.length > (delivery === 'npm' ? 2 : 3))
    throw new Error('Expected npm <archive>, or node|sea|launcher <archive> <platform>.');
  const target = PLATFORMS.find((supported) => supported === platform);
  const version = delivery === 'launcher' ? readLauncherCargoVersion(path.resolve(CLI_ROOT, '../..')) : cliVersion;
  if (delivery !== 'npm') {
    if (!target || path.basename(file) !== artifactName(delivery === 'launcher' ? 'launcher' : 'cli', version, target))
      throw new Error('Unexpected release target or archive filename.');
  }
  await verifyArchiveNotices(file, delivery as Delivery, version, target);
  process.stdout.write(`Verified the SBOM in ${path.basename(file)}.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
