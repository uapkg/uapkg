import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';
import { stripVTControlCharacters } from 'node:util';
import { resolveActiveUapkgProfileRoot } from '@uapkg/common';
import { PackageVersionSchema } from '@uapkg/common-schema';
import { z } from 'zod';
import { UAPKG_BUILD_METADATA } from '#cli/build/BuildMetadata.ts';
import {
  collectDebugEnvironment,
  DEBUG_COLLECTOR_ENV,
  runEnvironmentCollector,
  type EnvironmentCollection,
} from '#cli/cli/DebugEnvironment.ts';

const nullableVersion = PackageVersionSchema.nullable();
const sourceSchema = z.enum(['github-releases', 'npm']);
const launcherContextSchema = z.object({
  schemaVersion: z.literal(1),
  launcherVersion: PackageVersionSchema,
  launcherPath: z.string().min(1),
  installMethod: z.enum(['standalone', 'npm', 'winget', 'homebrew', 'scoop', 'development']),
  cliSource: sourceSchema.nullable(),
  globalSettingsState: z.enum(['available', 'unavailable']),
  globalCliVersion: nullableVersion,
  projectCliVersion: nullableVersion,
  projectState: z.enum(['pinned', 'unpinned', 'none', 'unavailable']),
  overrideCliVersion: nullableVersion,
  selectedCliVersion: PackageVersionSchema,
  selectionReason: z.enum(['development', 'override', 'global-command', 'project-pin', 'global-default']),
  engineKind: z.enum(['development', 'npm', 'node', 'sea']),
  offline: z.boolean(),
});
type LauncherContext = z.infer<typeof launcherContextSchema>;

/** Diagnostic flags are global; argument values and the -- delimiter remain opaque. */
export function requestsDebugInfo(args: readonly string[]): boolean {
  let enabled = false;
  let helpOrVersion = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') break;
    if (arg === '--registry' || arg === '--config') {
      if (args[index + 1] === '--') break;
      index++;
      continue;
    }
    if (['--help', '-h', '--version', '--help=true', '--version=true'].includes(arg)) helpOrVersion = true;
    if (arg === '--debug-info' || arg === '--debug-info=true') enabled = true;
    if (arg === '--debug-info=false' || arg === '--no-debug-info') enabled = false;
  }
  return enabled && !helpOrVersion;
}

function readObject(file: string): Record<string, unknown> {
  if (fs.statSync(file).size > 1024 * 1024) throw new Error('Configuration exceeds diagnostic size limit');
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isObject(value)) throw new Error('Expected an object');
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function directGlobal(profile: string) {
  try {
    const file = path.join(profile, 'config.json');
    const values = fs.existsSync(file) ? readObject(file) : {};
    const launcher = z
      .object({
        cliSource: sourceSchema.default('github-releases'),
        defaultCliVersion: PackageVersionSchema.optional(),
      })
      .parse(values.launcher === undefined ? {} : values.launcher);
    return {
      cliSource: launcher.cliSource,
      globalCliVersion: launcher.defaultCliVersion ?? null,
      globalSettingsState: 'available',
    } as const;
  } catch {
    return { cliSource: null, globalCliVersion: null, globalSettingsState: 'unavailable' } as const;
  }
}

function directProject(cwd: string): Pick<LauncherContext, 'projectCliVersion' | 'projectState'> {
  try {
    for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
      const manifestPath = path.join(directory, 'uapkg.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = readObject(manifestPath);
        if (manifest.kind === 'project') {
          return manifest.uapkgVersion === undefined
            ? { projectCliVersion: null, projectState: 'unpinned' }
            : { projectCliVersion: PackageVersionSchema.parse(manifest.uapkgVersion), projectState: 'pinned' };
        }
        if (manifest.kind !== 'plugin') return { projectCliVersion: null, projectState: 'unavailable' };
      }
      if (path.dirname(directory) === directory) return { projectCliVersion: null, projectState: 'none' };
    }
  } catch {
    return { projectCliVersion: null, projectState: 'unavailable' };
  }
}

function launcherContext(value: string | undefined, version: string): LauncherContext | null {
  if (!value || value.length > 8192) return null;
  try {
    const result = launcherContextSchema.safeParse(JSON.parse(value));
    if (!result.success || result.data.selectedCliVersion !== version) return null;
    return result.data;
  } catch {
    return null;
  }
}

/** Remove terminal controls and home paths even from tool-provided version text. */
function safeText(value: unknown, home: string, maxLength = 240): string {
  if (typeof value !== 'string' && typeof value !== 'number') return 'unavailable';
  let text = Array.from(stripVTControlCharacters(String(value)), (character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159) ? ' ' : character;
  }).join('');
  for (const spelling of new Set([home, home.replaceAll('\\', '/'), home.replaceAll('/', '\\')])) {
    if (spelling) {
      const pattern = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(pattern, /^[a-z]:[\\/]/i.test(home) ? 'gi' : 'g'), '~');
    }
  }
  return text.trim().slice(0, maxLength) || 'unavailable';
}

function probeValue(collection: EnvironmentCollection, category: string, field: string): unknown {
  if (!isObject(collection.values)) return undefined;
  const group = collection.values[category];
  if (!isObject(group)) return undefined;
  return group[field];
}

function probeField(collection: EnvironmentCollection, category: string, field: string): unknown {
  const value = probeValue(collection, category, field);
  // envinfo binary records contain { version, path }; paths are never included.
  return isObject(value) ? value.version : value;
}

function toolVersion(collection: EnvironmentCollection, category: string, field: string): string {
  const value = probeField(collection, category, field);
  return typeof value === 'string' && /^(?:v?\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?\.?|Not Found|N\/A)$/.test(value)
    ? value
    : 'unavailable';
}

export interface DebugInfoOptions {
  cwd?: string;
  profile?: string;
  home?: string;
  environment?: NodeJS.ProcessEnv;
  collect?: () => Promise<EnvironmentCollection>;
}

export async function renderDebugInfo(options: DebugInfoOptions = {}): Promise<string> {
  const environment = options.environment ?? process.env;
  const context = launcherContext(environment.UAPKG_LAUNCHER_CONTEXT, UAPKG_BUILD_METADATA.packageVersion);
  const selection = context ?? {
    ...directGlobal(options.profile ?? resolveActiveUapkgProfileRoot()),
    ...directProject(options.cwd ?? process.cwd()),
    launcherVersion: null,
    launcherPath: null,
    installMethod: null,
    overrideCliVersion: null,
    selectedCliVersion: UAPKG_BUILD_METADATA.packageVersion,
    selectionReason: 'direct engine',
    engineKind: isSea() ? 'sea' : 'direct Node',
    offline: null,
  };
  let collection: EnvironmentCollection;
  try {
    collection = await (options.collect ?? collectDebugEnvironment)();
  } catch {
    collection = { available: false, values: {} };
  }
  const clean = (value: unknown) => safeText(value, options.home ?? os.homedir());
  // Installation locations are intentionally complete, including the home directory.
  const cleanPath = (value: unknown) => safeText(value, '', Infinity);
  const cliPath = isSea() ? process.execPath : process.argv[1] ? path.resolve(process.argv[1]) : null;
  const versionOr = (value: string | null, fallback: string) => value ?? fallback;
  const project = selection.projectState === 'pinned' ? selection.projectCliVersion : selection.projectState;
  const shellValue = probeValue(collection, 'System', 'Shell');
  const shell = isObject(shellValue)
    ? `${typeof shellValue.path === 'string' ? shellValue.path.split(/[\\/]/).at(-1) : 'shell'} ${toolVersion(collection, 'System', 'Shell')}`
    : shellValue;
  const shellFallback = environment.SHELL
    ? path.basename(environment.SHELL)
    : process.platform === 'win32'
      ? 'Windows shell (version unavailable)'
      : undefined;
  return [
    'UAPKG debug information',
    '',
    'UAPKG:',
    `  CLI version: ${clean(UAPKG_BUILD_METADATA.displayVersion)}`,
    `  CLI path: ${cleanPath(cliPath)}`,
    `  Build: ${UAPKG_BUILD_METADATA.mode}`,
    `  Profile: ${UAPKG_BUILD_METADATA.mode}`,
    `  Launcher context: ${context ? 'available' : environment.UAPKG_LAUNCHER_CONTEXT ? 'unavailable (invalid or stale)' : 'unavailable (direct engine)'}`,
    `  Launcher version: ${versionOr(selection.launcherVersion, 'unavailable')}`,
    `  Launcher path: ${cleanPath(selection.launcherPath)}`,
    `  Installation owner: ${versionOr(selection.installMethod, 'unavailable')}`,
    `  CLI source: ${versionOr(selection.cliSource, 'unavailable')}`,
    `  Global settings: ${selection.globalSettingsState}`,
    `  Global CLI version: ${versionOr(selection.globalCliVersion, selection.globalSettingsState === 'unavailable' ? 'unavailable' : 'not configured')}`,
    `  Project CLI pin: ${project}`,
    `  Explicit CLI override: ${versionOr(selection.overrideCliVersion, context ? 'none' : 'unavailable')}`,
    `  Selected CLI version: ${selection.selectedCliVersion}`,
    `  Selection reason: ${selection.selectionReason}`,
    `  Engine kind: ${selection.engineKind}`,
    `  Offline: ${selection.offline === null ? 'unavailable' : selection.offline ? 'yes' : 'no'}`,
    `  Running Node: ${clean(process.versions.node)}`,
    '',
    'System:',
    `  Environment collection: ${collection.available ? 'available' : 'unavailable'}`,
    `  OS: ${clean(probeField(collection, 'System', 'OS') ?? `${os.type()} ${os.release()} (${process.arch})`)}`,
    `  CPU: ${clean(probeField(collection, 'System', 'CPU'))}`,
    `  Memory: ${clean(probeField(collection, 'System', 'Memory'))}`,
    `  Shell: ${clean(shell ?? shellFallback)}`,
    '',
    'Tools on PATH:',
    ...['Node', 'npm', 'pnpm'].map((name) => `  ${name}: ${toolVersion(collection, 'Binaries', name)}`),
    `  Git: ${toolVersion(collection, 'Utilities', 'Git')}`,
    '',
  ].join('\n');
}

export async function runDebugInfo(): Promise<number> {
  if (process.env[DEBUG_COLLECTOR_ENV] === '1') return await runEnvironmentCollector();
  process.stdout.write(await renderDebugInfo());
  return 0;
}
