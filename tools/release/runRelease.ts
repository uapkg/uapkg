import path from 'node:path';
import { CLI_ROOT, NPM_PACKAGE_ROOT, prepareNpmPackage, readJson } from '../../packages/uapkg/build/EnginePackage.ts';
import { buildNativeArtifacts, installRuntimeDependencies, launcherVersionFromCargo } from './NativeBuild.ts';
import { assembleCatalog, selectNativeCandidates } from './ReleaseArtifacts.ts';
import { smokeEngine } from './Smoke.ts';

export function parseOptions(args: string[]): { command: string; values: Map<string, string>; keyring: boolean } {
  const filtered = args.filter((arg) => arg !== '--');
  const command = filtered.shift() ?? '';
  const values = new Map<string, string>();
  let keyring = false;
  const supported = new Set([
    '--output',
    '--input',
    '--launcher',
    '--launcher-version',
    '--engine',
    '--package',
    '--npm-version',
    '--format',
  ]);
  for (let index = 0; index < filtered.length; index += 1) {
    const option = filtered[index];
    if (option === '--keyring') {
      keyring = true;
      continue;
    }
    const value = filtered[index + 1];
    if (!supported.has(option) || !value || value.startsWith('--') || values.has(option))
      throw new Error(`Invalid release option ${option}.`);
    values.set(option, value);
    index += 1;
  }
  return { command, values, keyring };
}

export async function runRelease(args: string[]): Promise<void> {
  const { command, values, keyring } = parseOptions(args);
  const required = (option: string): string => {
    const value = values.get(option);
    if (!value) throw new Error(`${command} requires ${option}.`);
    return value;
  };
  if (command === 'prepare-npm') {
    process.stdout.write(`${await prepareNpmPackage()}\n`);
  } else if (command === 'build-native') {
    const format = values.get('--format') ?? 'node';
    if (format !== 'node' && format !== 'sea') throw new Error('Engine format must be node or sea.');
    await buildNativeArtifacts(required('--output'), required('--launcher'), format);
  } else if (command === 'smoke-native') {
    smokeEngine(required('--engine'), { native: true, keyring });
  } else if (command === 'smoke-npm') {
    const directory = path.resolve(values.get('--package') ?? NPM_PACKAGE_ROOT);
    installRuntimeDependencies(directory, values.get('--npm-version'));
    smokeEngine(directory, { keyring });
  } else if (command === 'assemble') {
    const version = readJson<{ version: string }>(path.join(CLI_ROOT, 'package.json')).version;
    assembleCatalog(required('--input'), required('--output'), version, required('--launcher-version'));
  } else if (command === 'select-native') {
    const version = readJson<{ version: string }>(path.join(CLI_ROOT, 'package.json')).version;
    const launcherVersion =
      values.get('--launcher-version') ?? launcherVersionFromCargo(path.resolve(CLI_ROOT, '../..'));
    const evidence = selectNativeCandidates(required('--input'), required('--output'), version, launcherVersion);
    process.stdout.write(`Selected ${evidence.selectedFormat} engines for all six platforms.\n`);
  } else {
    throw new Error('Expected prepare-npm, build-native, smoke-native, smoke-npm, select-native, or assemble.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    await runRelease(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
