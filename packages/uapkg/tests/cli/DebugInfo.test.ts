import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { UAPKG_BUILD_METADATA } from '../../src/build/BuildMetadata.ts';
import { collectDebugEnvironment } from '../../src/cli/DebugEnvironment.ts';
import * as DebugInfo from '../../src/cli/DebugInfo.ts';
import * as CommandLine from '../../src/cli/parseCommandLine.ts';
import { runUAPKGCLI } from '../../src/cli/runUAPKGCLI.ts';

const directories: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uapkg-debug-info-'));
  directories.push(root);
  return { root, cwd: path.join(root, 'game'), profile: path.join(root, 'profile') };
}
function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
function context() {
  return {
    schemaVersion: 1,
    launcherVersion: '0.1.0',
    launcherPath: path.join(os.tmpdir(), 'uapkg launcher', 'uapkg.exe'),
    installMethod: 'standalone',
    cliSource: 'npm',
    globalSettingsState: 'available',
    globalCliVersion: '2.0.0',
    projectCliVersion: '3.0.0',
    projectState: 'pinned',
    overrideCliVersion: UAPKG_BUILD_METADATA.packageVersion,
    selectedCliVersion: UAPKG_BUILD_METADATA.packageVersion,
    selectionReason: 'override',
    engineKind: 'npm',
    offline: true,
  };
}
const collect = async () => ({
  available: true,
  values: {
    System: {
      OS: 'Example OS',
      CPU: 'Example CPU',
      Memory: '4 GB / 8 GB',
      Shell: { version: '5.0', path: '/private/shell' },
    },
    Binaries: {
      Node: { version: '26.0.0', path: '/private/node' },
      npm: { version: '12.2.2', path: '/private/npm' },
      pnpm: 'Not Found',
    },
    Utilities: { Git: { version: '2.55.0', path: '/private/git' } },
    npmPackages: { 'private-package': 'private-version' },
    secrets: 'private-token',
  },
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('debug-info routing', () => {
  it.each([
    [[], false],
    [['--debug-info'], true],
    [['install', '--debug-info'], true],
    [['--debug-info=true', 'unknown'], true],
    [['--debug-info', '--debug-info=false'], false],
    [['--no-debug-info', '--debug-info'], true],
    [['--debug-info', '--no-debug-info'], false],
    [['install', '--', '--debug-info'], false],
    [['--registry', '--debug-info'], false],
    [['--config', '--debug-info', 'install'], false],
    [['--registry', '--', '--debug-info'], false],
    [['--config', '--', '--debug-info'], false],
    [['--debug-info', '--help'], false],
    [['--debug-info', '--version'], false],
    [['--debug-info', '--', '--help'], true],
  ] as const)('respects flags and literal arguments %j', (args, expected) => {
    expect(DebugInfo.requestsDebugInfo(args)).toBe(expected);
  });

  it.each([{ args: ['--debug-info'] }, { args: ['install', '--debug-info'] }])(
    'returns diagnostics before parsing or dispatching %j',
    async ({ args }) => {
      const report = vi.spyOn(DebugInfo, 'runDebugInfo').mockResolvedValue(0);
      const parse = vi.spyOn(CommandLine, 'parseUAPKGCommandLine');
      expect(await runUAPKGCLI(['node', 'cli.js', ...args])).toBe(0);
      expect(report).toHaveBeenCalledOnce();
      expect(parse).not.toHaveBeenCalled();
    },
  );
});

describe('copyable diagnostic report', () => {
  it('reports authoritative launcher selection and only allowlisted environment fields', async () => {
    const f = fixture();
    const report = await DebugInfo.renderDebugInfo({
      ...f,
      collect,
      environment: { UAPKG_LAUNCHER_CONTEXT: JSON.stringify({ ...context(), secret: 'context-secret' }) },
    });
    expect(report).toContain('UAPKG debug information');
    expect(report).toContain('Launcher version: 0.1.0');
    expect(report).toContain(`Launcher path: ${context().launcherPath}`);
    expect(report).toContain(`CLI path: ${path.resolve(process.argv[1]!)}`);
    expect(report).toContain('Installation owner: standalone');
    expect(report).toContain('CLI source: npm');
    expect(report).toContain('Global CLI version: 2.0.0');
    expect(report).toContain('Project CLI pin: 3.0.0');
    expect(report).toContain(`Explicit CLI override: ${UAPKG_BUILD_METADATA.packageVersion}`);
    expect(report).toContain('Selection reason: override');
    expect(report).toContain('Engine kind: npm');
    expect(report).toContain('Offline: yes');
    expect(report).toContain(`Running Node: ${process.versions.node}`);
    expect(report).toContain('Node: 26.0.0');
    expect(report).toContain('pnpm: Not Found');
    expect(report).not.toMatch(/private-token|context-secret|private-package|private-version/);
    expect(report).not.toContain('/private/');
    expect(report).not.toContain('\x1b');
    expect(fs.readdirSync(f.root)).toEqual([]);
  });

  it.each(['malformed JSON', JSON.stringify({ ...context(), selectedCliVersion: '999.0.0' })])(
    'ignores invalid or stale launcher context',
    async (raw) => {
      const f = fixture();
      write(path.join(f.profile, 'config.json'), {
        launcher: { cliSource: 'github-releases', defaultCliVersion: '4.0.0' },
      });
      const report = await DebugInfo.renderDebugInfo({ ...f, collect, environment: { UAPKG_LAUNCHER_CONTEXT: raw } });
      expect(report).toContain('Launcher context: unavailable (invalid or stale)');
      expect(report).toContain('Global CLI version: 4.0.0');
      expect(report).toContain('Selection reason: direct engine');
      expect(report).toContain('Launcher path: unavailable');
      expect(report).toContain(`CLI path: ${path.resolve(process.argv[1]!)}`);
      expect(report).not.toContain('999.0.0');
    },
  );

  it('uses only global launcher settings and skips plugins during direct-engine pin discovery', async () => {
    const f = fixture();
    write(path.join(f.profile, 'config.json'), {
      launcher: { cliSource: 'npm', defaultCliVersion: '2.0.0' },
      registry: 'private-registry',
    });
    write(path.join(f.cwd, 'uapkg.json'), { kind: 'project', uapkgVersion: '3.0.0' });
    const plugin = path.join(f.cwd, 'Plugins', 'PrivateProjectName');
    write(path.join(plugin, 'uapkg.json'), { kind: 'plugin', uapkgVersion: '99.0.0' });
    write(path.join(plugin, '.uapkg', 'config.json'), {
      launcher: { cliSource: 'github-releases', defaultCliVersion: '99.0.0' },
    });
    const report = await DebugInfo.renderDebugInfo({ ...f, cwd: plugin, collect, environment: {} });
    expect(report).toContain('CLI source: npm');
    expect(report).toContain('Global CLI version: 2.0.0');
    expect(report).toContain('Project CLI pin: 3.0.0');
    expect(report).not.toMatch(/99\.0\.0|private-registry|PrivateProjectName/);
    write(path.join(plugin, 'nested', 'uapkg.json'), { kind: 'project' });
    expect(
      await DebugInfo.renderDebugInfo({ ...f, cwd: path.join(plugin, 'nested'), collect, environment: {} }),
    ).toContain('Project CLI pin: unpinned');
  });

  it('returns a partial report without exposing malformed configuration or collection failures', async () => {
    const f = fixture();
    write(path.join(f.profile, 'config.json'), { launcher: { cliSource: 'private-invalid-source' } });
    write(path.join(f.cwd, 'uapkg.json'), { kind: 'project', uapkgVersion: 'private-invalid-pin' });
    const report = await DebugInfo.renderDebugInfo({
      ...f,
      environment: {},
      collect: async () => {
        throw new Error('private-command-output');
      },
    });
    expect(report).toContain('Global settings: unavailable');
    expect(report).toContain('Project CLI pin: unavailable');
    expect(report).toContain('Environment collection: unavailable');
    expect(report).not.toMatch(/private-invalid|private-command-output/);
  });

  it('reports an explicit null launcher object as invalid global settings', async () => {
    const f = fixture();
    write(path.join(f.profile, 'config.json'), { launcher: null });
    const report = await DebugInfo.renderDebugInfo({ ...f, collect, environment: {} });
    expect(report).toContain('Global settings: unavailable');
    expect(report).toContain('CLI source: unavailable');
  });

  it('removes control sequences and home paths from probe values', async () => {
    const f = fixture();
    const report = await DebugInfo.renderDebugInfo({
      ...f,
      home: '/home/private',
      environment: {},
      collect: async () => ({
        available: true,
        values: { System: { OS: '\x1b[31mOS\x1b[0m\n/home/private/machine' } },
      }),
    });
    expect(report).toContain('OS: OS ~/machine');
    expect(report).not.toContain('/home/private');
    expect(report).not.toContain('\x1b');
  });

  it('shows full launcher paths without home redaction or truncation', async () => {
    const f = fixture();
    const launcherPath = `C:\\Users\\example\\${'long directory\\'.repeat(20)}uapkg.exe`;
    const report = await DebugInfo.renderDebugInfo({
      ...f,
      home: 'C:\\Users\\example',
      collect,
      environment: { UAPKG_LAUNCHER_CONTEXT: JSON.stringify({ ...context(), launcherPath }) },
    });
    expect(report).toContain(`Launcher path: ${launcherPath}`);
  });
});

describe('isolated environment collection', () => {
  it('loads the published CommonJS envinfo package through native Node ESM', async () => {
    const entry = pathToFileURL(path.resolve(import.meta.dirname, '../../src/cli/DebugEnvironment.ts')).href;
    vi.stubEnv('ENVINFO_DEBUG', 'trace');
    vi.stubEnv('UAPKG_DIAGNOSTIC_PRIVATE_SENTINEL', 'never-print-this-value');
    const collection = await collectDebugEnvironment({
      executable: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        `const { runEnvironmentCollector } = await import(${JSON.stringify(entry)}); process.exitCode = await runEnvironmentCollector();`,
      ],
    });
    expect(collection.available).toBe(true);
    expect(collection.values).toMatchObject({ System: { OS: expect.any(String) } });
    expect(JSON.stringify(collection.values)).not.toContain('never-print-this-value');
  });

  it('clears verbose environment logging and disables automatic runtime downloads', async () => {
    vi.stubEnv('ENVINFO_DEBUG', 'trace');
    const collection = await collectDebugEnvironment({
      executable: process.execPath,
      args: [
        '-e',
        `process.stdout.write(JSON.stringify({ debug: process.env.ENVINFO_DEBUG ?? null, network: process.env.COREPACK_ENABLE_NETWORK, prompt: process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT }))`,
      ],
    });
    expect(collection).toEqual({ available: true, values: { debug: null, network: '0', prompt: '0' } });
  });

  it('bounds a hanging environment probe and returns an unavailable result', async () => {
    const started = Date.now();
    expect(
      await collectDebugEnvironment({ executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, 100),
    ).toEqual({ available: false, values: {} });
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
