import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { INTERNAL_PROFILE_HOME_ENV } from '@uapkg/common';
import { ok } from '@uapkg/diagnostics';
import { getRegistryRepoPath } from '@uapkg/registry-core';
import { getRegistryPackagePathSegments } from '@uapkg/registry-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { CompositionRoot } from '../../src/app/CompositionRoot.ts';
import { AddCommand, type AddCommandOptions } from '../../src/commands/AddCommand.ts';

const day = 86_400;
const now = 1_800_000_000;
const integrity = `sha256:${'b'.repeat(64)}`;

function release(ageSeconds: number, dependencies: Record<string, string> = {}) {
  return {
    meta: { publishedAt: now - ageSeconds },
    dependencies,
    releaseFiles: { package: { url: 'https://example.test/plugin.tgz', integrity: { hash: integrity, size: 1 } } },
  };
}

async function writeJson(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data));
}

describe('add with a local registry and project files', () => {
  let directory: string;
  let project: string;
  let registryRepo: string;
  let root: CompositionRoot;

  async function publish(name: string, versions: Record<string, ReturnType<typeof release>>) {
    await writeJson(join(registryRepo, ...getRegistryPackagePathSegments(name)), {
      name,
      packageSource: { type: 'git', url: 'https://example.test/source' },
      versions,
    });
  }

  async function add(options: Partial<AddCommandOptions> = {}) {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await new AddCommand(root, {
      spec: 'terrain',
      pin: false,
      dev: false,
      force: false,
      dryRun: true,
      outputFormat: 'json',
      registry: 'studio',
      ...options,
    }).execute();
    return { code, output: writes.join('') };
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'uapkg-add-'));
    project = join(directory, 'project');
    vi.stubEnv(INTERNAL_PROFILE_HOME_ENV, join(directory, 'profile'));
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    await writeJson(join(project, 'uapkg.json'), {
      name: 'game',
      kind: 'project',
      version: '1.0.0',
      dependencies: { mesh: { version: '1.0.0', registry: 'studio' } },
    });
    await writeJson(join(project, 'uapkg.lock'), {
      lockfileVersion: 1,
      packages: { mesh: { version: '1.0.0', registry: 'studio', integrity } },
    });
    await writeJson(join(project, '.uapkg/config.json'), {
      registries: { studio: { url: 'https://example.test/studio' } },
    });
    root = new CompositionRoot({ cwd: project });
    const registry = root.registryCore.getOrCreateRegistry('studio');
    if (!registry.ok) throw new Error(JSON.stringify(registry.diagnostics));
    vi.spyOn(registry.value, 'ensureUpToDate').mockResolvedValue(ok('AlreadyFresh'));
    registryRepo = getRegistryRepoPath(registry.value.shortId);
    await writeJson(join(registryRepo, '.uapkg/registry.meta.json'), {
      schemaVersion: 1,
      registry: { id: '00000000-0000-4000-a000-000000000020', name: 'Studio', registryType: 'private' },
    });
    await publish('mesh', { '1.0.0': release(60), '2.0.0': release(10 * day) });
    await publish('terrain', {
      '1.4.9': release(8 * day),
      '2.0.0': release(3600),
      '3.0.0': release(7 * day, { mesh: '^2.0.0' }),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['default', 'studio'])(
    'selects default when the configured registry is %s and the flag is omitted',
    async (registry) => {
      const source = { url: 'https://example.test/studio' };
      await writeJson(join(project, '.uapkg/config.json'), {
        registry,
        registries: { default: source, studio: source },
      });
      root.config.reload();

      const options = { spec: 'absent', registry: undefined };
      const json = await add(options);
      expect(json.code).toBe(1);
      expect(JSON.parse(json.output)).toMatchObject({
        status: 'error',
        diagnostics: [
          {
            code: 'PACKAGE_NOT_FOUND',
            message: 'Package "absent" not found in registry "default".',
            data: { packageName: 'absent', registry: 'default' },
          },
        ],
      });

      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      expect((await add({ ...options, outputFormat: 'text' })).code).toBe(1);
      const text = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(stripVTControlCharacters(text)).toContain('Could not find absent in registry default.');
    },
  );

  it('asks which registry to use before changing a dependency found in default and declared in studio', async () => {
    const defaultRegistry = root.registryCore.getOrCreateRegistry('default');
    if (!defaultRegistry.ok) throw new Error(JSON.stringify(defaultRegistry.diagnostics));
    vi.spyOn(defaultRegistry.value, 'ensureUpToDate').mockResolvedValue(ok('AlreadyFresh'));
    const defaultRepo = getRegistryRepoPath(defaultRegistry.value.shortId);
    await writeJson(join(defaultRepo, '.uapkg/registry.meta.json'), {
      schemaVersion: 1,
      registry: { id: '00000000-0000-4000-a000-000000000021', name: 'Default', registryType: 'private' },
    });
    await writeJson(join(defaultRepo, ...getRegistryPackagePathSegments('mesh')), {
      name: 'mesh',
      packageSource: { type: 'git', url: 'https://example.test/other-source' },
      versions: { '1.0.0': release(10 * day) },
    });
    const files = ['uapkg.json', 'uapkg.lock'].map((file) => join(project, file));
    const before = await Promise.all(files.map((path) => readFile(path, 'utf8')));
    const ambiguous = await add({ spec: 'mesh', registry: undefined });
    expect(ambiguous.code).toBe(1);
    expect(JSON.parse(ambiguous.output)).toMatchObject({
      status: 'error',
      command: 'add',
      diagnostics: [
        {
          code: 'PACKAGE_REGISTRY_AMBIGUOUS',
          message: expect.stringContaining('mesh'),
          hint: expect.stringMatching(/--registry default[\s\S]*--registry studio/),
          data: { packageName: 'mesh', registries: ['default', 'studio'] },
        },
      ],
    });
    expect(await Promise.all(files.map((path) => readFile(path, 'utf8')))).toEqual(before);
    expect((await add({ spec: 'mesh', registry: 'studio' })).code).toBe(0);
    const selected = await add({ spec: 'mesh', registry: 'default' });
    expect(selected.code, selected.output).toBe(0);
    expect(JSON.parse(await readFile(files[1], 'utf8')).packages.mesh.registry).toBe('default');
  });

  it('keeps an existing private override intact when default lacks the package', async () => {
    const registry = root.registryCore.getOrCreateRegistry('default');
    if (!registry.ok) throw new Error(JSON.stringify(registry.diagnostics));
    vi.spyOn(registry.value, 'ensureUpToDate').mockResolvedValue(ok('AlreadyFresh'));
    const manifestPath = join(project, 'uapkg.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.overrides = { mesh: manifest.dependencies.mesh };
    await writeJson(manifestPath, manifest);

    const result = await add({ spec: 'mesh', registry: undefined });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output).diagnostics).toEqual([
      expect.objectContaining({ code: 'PACKAGE_NOT_FOUND', data: { packageName: 'mesh', registry: 'default' } }),
    ]);
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual(manifest);
  });

  it('writes the selected caret to the dev declaration and override, reporting the compatible newer major', async () => {
    const { code, output } = await add({ dev: true, pin: true });
    expect(code, output).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      status: 'ok',
      command: 'add',
      data: {
        heldBack: [
          { name: 'terrain', selectedVersion: '1.4.9', blockedVersion: '2.0.0', eligibleInSeconds: 3 * day - 3600 },
        ],
      },
    });
    const declaration = { version: '^1.4.9', registry: 'studio' };
    expect(JSON.parse(await readFile(join(project, 'uapkg.json'), 'utf8'))).toMatchObject({
      devDependencies: { terrain: declaration },
      overrides: { terrain: declaration },
    });
    expect(JSON.parse(await readFile(join(project, 'uapkg.lock'), 'utf8')).packages).toMatchObject({
      terrain: { version: '1.4.9', registry: 'studio' },
      mesh: { version: '1.0.0' },
    });
  });

  it.each([
    ['terrain', '^1.4.9'],
    ['terrain@*', '*'],
  ])('explains the holdback for %s in text and saves %s', async (spec, savedRange) => {
    const { code, output } = await add({ spec, outputFormat: 'text' });
    expect(code, output).toBe(0);
    for (const detail of ['terrain', '1.4.9', '2.0.0', '3d', /2d\s*23h/]) expect(output).toMatch(detail);
    expect(output).not.toContain('3.0.0');
    expect(JSON.parse(await readFile(join(project, 'uapkg.json'), 'utf8')).dependencies.terrain.version).toBe(
      savedRange,
    );
  });

  it('saves the highest compatible version with the new-package opt-out', async () => {
    await writeJson(join(project, '.uapkg/config.json'), {
      registries: { studio: { url: 'https://example.test/studio' } },
      packages: { resolution: { applyReleaseAgeToNewPackages: false } },
    });
    root.config.reload();
    const { code, output } = await add();
    expect(code, output).toBe(0);
    expect(JSON.parse(output).data.heldBack).toEqual([]);
    expect(JSON.parse(await readFile(join(project, 'uapkg.json'), 'utf8')).dependencies.terrain.version).toBe('^2.0.0');
    expect(JSON.parse(await readFile(join(project, 'uapkg.lock'), 'utf8')).packages.terrain.version).toBe('2.0.0');
  });

  it('preserves both files on a cooldown failure and succeeds with the suggested override', async () => {
    await publish('terrain', { '1.4.9': release(3600), '2.0.0': release(60) });
    const files = [join(project, 'uapkg.json'), join(project, 'uapkg.lock')];
    const before = await Promise.all(files.map((path) => readFile(path, 'utf8')));
    const blocked = await add();
    expect(blocked.code, blocked.output).toBe(1);
    expect(JSON.parse(blocked.output)).toMatchObject({
      status: 'error',
      diagnostics: [
        {
          code: 'RELEASE_AGE_BLOCKED',
          message: expect.stringContaining(new Date((now - 3600 + 3 * day) * 1000).toISOString()),
          data: { overrideCommand: 'uapkg add terrain --registry studio --dry-run --json --ignore-release-age' },
        },
      ],
    });
    expect(await Promise.all(files.map((path) => readFile(path, 'utf8')))).toEqual(before);
    const override = await add({ ignoreReleaseAge: true });
    expect(override.code, override.output).toBe(0);
    expect(JSON.parse(await readFile(files[1], 'utf8')).packages.terrain.version).toBe('2.0.0');
  });
});
