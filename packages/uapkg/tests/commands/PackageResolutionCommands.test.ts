import { fail, ok, type Diagnostic, type Result } from '@uapkg/diagnostics';
import type { DownloadStatusSnapshot, InstallReport } from '@uapkg/installer';
import type { HeldBackRelease, ManifestInstallOptions, ManifestInstallReport } from '@uapkg/package-manifest';
import { ManifestSchema, type Lockfile } from '@uapkg/package-manifest-schema';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CompositionRoot } from '../../src/app/CompositionRoot.ts';
import { AddCommand, type AddCommandOptions } from '../../src/commands/AddCommand.ts';
import { InstallCommand } from '../../src/commands/InstallCommand.ts';
import { RemoveCommand } from '../../src/commands/RemoveCommand.ts';
import { UpdateCommand } from '../../src/commands/UpdateCommand.ts';

const noActions: InstallReport = {
  plan: { actions: [], summary: { added: 0, updated: 0, removed: 0, unchanged: 0, totalBytes: 0 } },
  outcomes: [],
  installed: [],
  failed: [],
  skipped: [],
  incompleteClosure: [],
};
const emptyLock: Lockfile = { lockfileVersion: 1, packages: {} };
const resolutionFailure: Diagnostic = {
  code: 'VERSION_NOT_FOUND',
  level: 'error',
  message: 'No eligible version satisfies the requested range.',
} as Diagnostic;

function fixture(input: Record<string, unknown> = {}, previousLockfile: Lockfile | null = null) {
  const original = ManifestSchema.parse({ name: 'game', version: '1.0.0', kind: 'project', ...input });
  const heldBack: HeldBackRelease[] = [];
  const packageManifest = {
    readManifest: vi.fn(async () => ok(original)),
    readLockfileOptional: vi.fn(async () => ok(previousLockfile)),
    writeManifest: vi.fn(),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    installWithReport: vi.fn(async (options: ManifestInstallOptions): Promise<Result<ManifestInstallReport>> =>
      ok({
        manifest: options.stagedManifest ? ManifestSchema.parse(options.stagedManifest) : original,
        lockfile: previousLockfile ?? emptyLock,
        previousLockfile,
        heldBack,
        minimumReleaseAge: '3d',
      }),
    ),
  };
  const installer = {
    getStatusStream: vi.fn(() => statusStream()),
    execute: vi.fn(async () => ok(noActions)),
  };
  const json = { emit: vi.fn() };
  const diagnostics = { reportAll: vi.fn() };
  const root = {
    cwd: '/project',
    packageManifest,
    installer,
    json,
    diagnostics,
    config: { get: vi.fn(() => 'official') },
    postinstall: { run: vi.fn() },
  } as unknown as CompositionRoot;
  const add = (options: Partial<AddCommandOptions> = {}) =>
    new AddCommand(root, {
      spec: 'example',
      pin: false,
      dev: false,
      force: false,
      dryRun: true,
      outputFormat: 'json',
      ...options,
    }).execute();
  return { root, original, packageManifest, installer, json, diagnostics, heldBack, add };
}

async function* statusStream(): AsyncGenerator<DownloadStatusSnapshot> {
  yield { slots: [], totals: { added: 0, updated: 0, removed: 0, unchanged: 0, bytesDone: 50, bytesTotal: 100 } };
}

afterEach(() => vi.restoreAllMocks());

describe('package resolution command integration', () => {
  it('asks the shared resolver to choose a new bare add before saving its range', async () => {
    const f = fixture();
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    expect(await f.add()).toBe(0);
    const request = f.packageManifest.installWithReport.mock.calls[0][0];
    expect(request).toMatchObject({
      newRoots: ['example'],
      updateTargets: ['example'],
      requiredVersions: undefined,
      bareAdd: { name: 'example', bucket: 'dependencies', pin: false },
      nowMs: 123456,
      previousLockfile: null,
    });
    expect(request.stagedManifest?.dependencies?.example).toEqual({ version: '*', registry: 'official' });
    expect(f.packageManifest.addDependency).not.toHaveBeenCalled();
    expect(f.original.dependencies).toBeUndefined();
    expect(f.json.emit).toHaveBeenCalledWith(expect.objectContaining({ command: 'add', status: 'ok' }));
  });

  it('treats the valid package name constructor as a new package rather than inherited map state', async () => {
    const f = fixture({ dependencies: {}, overrides: {} }, emptyLock);
    expect(await f.add({ spec: 'constructor' })).toBe(0);
    expect(f.packageManifest.installWithReport.mock.calls[0][0]).toMatchObject({
      newRoots: ['constructor'],
      requiredVersions: undefined,
      bareAdd: { name: 'constructor' },
    });
  });

  it('rejects an undeclared constructor update without resolving inherited object properties', async () => {
    const f = fixture({ dependencies: {} });
    expect(
      await new UpdateCommand(f.root, {
        specs: ['constructor'],
        force: false,
        dryRun: false,
        outputFormat: 'json',
      }).execute(),
    ).toBe(1);
    expect(f.packageManifest.installWithReport).not.toHaveBeenCalled();
  });

  it.each(['^1.0.0', '*'])('preserves the explicitly requested range %s for a new package', async (range) => {
    const f = fixture();
    expect(await f.add({ spec: `example@${range}` })).toBe(0);
    const request = f.packageManifest.installWithReport.mock.calls[0][0];
    expect(request).toMatchObject({
      newRoots: ['example'],
      requiredVersions: undefined,
    });
    expect(request.bareAdd).toBeUndefined();
    expect(request.stagedManifest?.dependencies?.example.version).toBe(range);
  });

  it('preserves an existing omitted registry identity when the configured add registry differs', async () => {
    const f = fixture({ dependencies: { example: '^1.0.0' } });
    expect(await f.add()).toBe(0);
    const request = f.packageManifest.installWithReport.mock.calls[0][0];
    expect(request).not.toHaveProperty('stagedManifest');
    expect(request.originalManifest?.dependencies?.example.registry).toBeUndefined();
  });

  it('treats an existing project override as existing intent without a new-add bypass', async () => {
    const f = fixture({ overrides: { example: { version: '^1.0.0', registry: 'private' } } });
    expect(await f.add()).toBe(0);
    const request = f.packageManifest.installWithReport.mock.calls[0][0];
    expect(request).toMatchObject({ newRoots: [], requiredVersions: undefined, updateTargets: ['example'] });
    expect(ManifestSchema.parse(request.stagedManifest).dependencies?.example).toMatchObject({
      version: '^1.0.0',
      registry: 'private',
    });
  });

  it.each(['add', 'update'] as const)(
    'passes an exact typed %s version to detect a conflicting override',
    async (command) => {
      const f = fixture({ dependencies: { example: '^1.0.0' }, overrides: { example: '1.0.0' } });
      const result =
        command === 'add'
          ? await f.add({ spec: 'example@1.2.3' })
          : await new UpdateCommand(f.root, {
              specs: ['example@1.2.3'],
              force: false,
              dryRun: false,
              outputFormat: 'json',
            }).execute();
      expect(result).toBe(0);
      const request = f.packageManifest.installWithReport.mock.calls[0][0];
      expect(request.requiredVersions).toEqual({ example: '1.2.3' });
      expect(ManifestSchema.parse(request.stagedManifest).overrides).toEqual(f.original.overrides);
    },
  );

  it('preserves the range, registry, bucket, path and bytes of an existing bare declaration', async () => {
    const f = fixture({
      devDependencies: { example: { version: '^1.0.0', registry: 'private', path: 'Plugins/Custom' } },
    });
    expect(await f.add()).toBe(0);
    const request = f.packageManifest.installWithReport.mock.calls[0][0];
    expect(request).toMatchObject({ updateTargets: ['example'], newRoots: [], requiredVersions: undefined });
    expect(request).not.toHaveProperty('stagedManifest');
    expect(f.original.devDependencies?.example.path).toBe('Plugins/Custom');
  });

  it('does not bypass cooldown or manufacture a new latest floor when promoting a locked transitive package', async () => {
    const previous = {
      lockfileVersion: 1,
      packages: { example: { version: '1.0.0', registry: 'private', integrity: 'hash' } },
    } as unknown as Lockfile;
    const f = fixture({}, previous);
    expect(await f.add()).toBe(0);
    const request = f.packageManifest.installWithReport.mock.calls[0][0];
    expect(request).toMatchObject({
      newRoots: [],
      requiredVersions: undefined,
      updateTargets: ['example'],
      previousLockfile: previous,
    });
    expect(ManifestSchema.parse(request.stagedManifest).dependencies?.example).toMatchObject({
      version: '^1.0.0',
      registry: 'private',
    });
  });

  it('validates every update spec before writing or installing any range changes', async () => {
    const f = fixture({ dependencies: { example: '^1.0.0' } });
    expect(
      await new UpdateCommand(f.root, {
        specs: ['example@^2.0.0', 'missing'],
        force: false,
        dryRun: false,
        outputFormat: 'json',
      }).execute(),
    ).toBe(1);
    expect(f.packageManifest.installWithReport).not.toHaveBeenCalled();
    expect(f.packageManifest.writeManifest).not.toHaveBeenCalled();
    expect(f.packageManifest.addDependency).not.toHaveBeenCalled();
    expect(f.original.dependencies?.example.version).toBe('^1.0.0');
  });

  it('stages targeted ranges without losing path or registry and passes recursive/override intent', async () => {
    const f = fixture({
      dependencies: { example: { version: '^1.0.0', registry: 'private', path: 'Plugins/Custom' }, other: '^1.0.0' },
    });
    expect(
      await new UpdateCommand(f.root, {
        specs: ['example@^2.0.0'],
        force: true,
        dryRun: true,
        recursive: true,
        ignoreReleaseAge: true,
        outputFormat: 'json',
      }).execute(),
    ).toBe(0);
    const request = f.packageManifest.installWithReport.mock.calls[0][0];
    expect(request).toMatchObject({ updateTargets: ['example'], recursive: true, ignoreReleaseAge: true });
    expect(ManifestSchema.parse(request.stagedManifest).dependencies?.example).toMatchObject({
      version: '^2.0.0',
      registry: 'private',
      path: 'Plugins/Custom',
    });
    expect(request.overrideCommand).toContain(
      'uapkg update example@^2.0.0 --recursive --force --dry-run --json --ignore-release-age',
    );
    expect(f.installer.execute).toHaveBeenCalledWith(
      expect.anything(),
      null,
      expect.objectContaining({ force: true, dryRun: true }),
    );
    expect(f.json.emit).toHaveBeenCalledWith(expect.objectContaining({ command: 'update' }));
  });

  it.each([{ specs: [] }, { specs: ['example'] }])(
    'does not rewrite an unchanged update manifest for $specs',
    async ({ specs }) => {
      const f = fixture({ dependencies: { example: '^1.0.0' } });
      expect(
        await new UpdateCommand(f.root, { specs, force: false, dryRun: false, outputFormat: 'json' }).execute(),
      ).toBe(0);
      expect(f.packageManifest.installWithReport.mock.calls[0][0]).not.toHaveProperty('stagedManifest');
    },
  );

  it('reports genuine resolution failure without an earlier manifest mutation', async () => {
    const f = fixture();
    f.packageManifest.installWithReport.mockResolvedValueOnce(fail([resolutionFailure]));
    expect(await f.add()).toBe(1);
    expect(f.packageManifest.writeManifest).not.toHaveBeenCalled();
    expect(f.packageManifest.addDependency).not.toHaveBeenCalled();
    expect(f.installer.execute).not.toHaveBeenCalled();
    expect(f.json.emit).toHaveBeenCalledWith({ status: 'error', command: 'add', diagnostics: [resolutionFailure] });
  });

  it('includes held-back packages as successful JSON data and emits no progress text', async () => {
    const f = fixture();
    f.heldBack.push({
      name: 'example',
      registry: 'official',
      selectedVersion: '1.0.0',
      blockedVersion: '1.1.0',
      publishedAt: 100,
      eligibleInSeconds: 3600,
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(
      await new InstallCommand(f.root, { force: false, frozen: false, dryRun: false, outputFormat: 'json' }).execute(),
    ).toBe(0);
    expect(stdout).not.toHaveBeenCalled();
    expect(f.json.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ok',
        command: 'install',
        data: expect.objectContaining({ heldBack: f.heldBack, minimumReleaseAge: '3d' }),
        diagnostics: [],
      }),
    );
  });

  it.each([0, 1])('reports %i held-back packages in a successful update JSON summary', async (count) => {
    const f = fixture({ dependencies: { example: '^1.0.0' } });
    if (count > 0)
      f.heldBack.push({
        name: 'example',
        registry: 'official',
        selectedVersion: '1.0.0',
        blockedVersion: '1.1.0',
        publishedAt: 100,
        eligibleInSeconds: 3600,
      });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(
      await new UpdateCommand(f.root, {
        specs: ['example'],
        force: false,
        dryRun: false,
        outputFormat: 'json',
      }).execute(),
    ).toBe(0);
    expect(stdout).not.toHaveBeenCalled();
    expect(f.json.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ok',
        command: 'update',
        diagnostics: [],
        data: expect.objectContaining({
          heldBackCount: count,
          heldBack: f.heldBack,
          plan: expect.objectContaining({ updated: 0 }),
        }),
      }),
    );
  });

  it.each([0, 1])(
    'reports %i held-back packages in the text update summary with a scoped retry tip when needed',
    async (count) => {
      const f = fixture({ dependencies: { example: '^1.0.0' } });
      if (count > 0)
        f.heldBack.push({
          name: 'example',
          registry: 'official',
          selectedVersion: '1.0.0',
          blockedVersion: '1.1.0',
          publishedAt: 100,
          eligibleInSeconds: 3600,
        });
      const writes: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      expect(
        await new UpdateCommand(f.root, {
          specs: ['example'],
          recursive: true,
          force: false,
          dryRun: false,
          outputFormat: 'text',
        }).execute(),
      ).toBe(0);
      const output = writes.join('');
      expect(output).toContain(`${count} held back`);
      if (count > 0) {
        expect(output).toContain('eligible in 1h');
        expect(output).toContain('uapkg update example --recursive --ignore-release-age');
      } else expect(output).not.toContain('--ignore-release-age');
      expect(f.json.emit).not.toHaveBeenCalled();
    },
  );

  it('stages removal while leaving unrelated locks and installer safety settings to the shared facade', async () => {
    const f = fixture({ dependencies: { example: '^1.0.0', other: '^1.0.0' } });
    expect(await new RemoveCommand(f.root, { packageName: 'example', outputFormat: 'json' }).execute()).toBe(0);
    const request = f.packageManifest.installWithReport.mock.calls[0][0];
    expect(request.updateTargets).toBeUndefined();
    expect(ManifestSchema.parse(request.stagedManifest).dependencies).toEqual({ other: { version: '^1.0.0' } });
    expect(f.packageManifest.removeDependency).not.toHaveBeenCalled();
    expect(f.installer.execute).toHaveBeenCalledWith(
      expect.anything(),
      null,
      expect.objectContaining({ force: false }),
    );
    expect(f.json.emit).toHaveBeenCalledWith(expect.objectContaining({ command: 'remove' }));
  });
});
