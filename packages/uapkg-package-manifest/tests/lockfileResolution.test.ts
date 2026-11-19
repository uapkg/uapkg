import fs, { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ok } from '@uapkg/diagnostics';
import { LockfileSchema, ManifestSchema } from '@uapkg/package-manifest-schema';
import type { RegistryCore } from '@uapkg/registry-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PackageManifest } from '../src/core/PackageManifest.ts';

const now = 1_800_000_000;
const hash = `sha256:${'b'.repeat(64)}`;
const gitTree = 'a'.repeat(40);
const project = { kind: 'project', name: 'game', version: '0.0.1', dependencies: { mesh: '^1.0.0' } };
const lock = {
  lockfileVersion: 1,
  packages: { mesh: { registry: 'default', version: '1.0.1', integrity: hash, gitTree } },
};

function published(seconds: number) {
  return {
    gitTree,
    private: false,
    meta: { publishedAt: seconds },
    releaseFiles: { package: { url: 'https://example.test/mesh.tgz', integrity: { hash, size: 10 } } },
  };
}

describe('lockfile resolution through PackageManifest', () => {
  let directory: string;
  let pm: PackageManifest;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'uapkg-lock-resolution-'));
    const registry = {
      getPackageManifest: async () =>
        ok({
          name: 'mesh',
          versions: { '1.0.0': published(123), '1.0.1': published(now - 1800), '1.0.2': published(now - 900) },
        }),
    };
    pm = new PackageManifest({
      manifestRoot: directory,
      registryCore: { getOrCreateRegistry: () => ok(registry) } as unknown as RegistryCore,
    });
    await writeFile(join(directory, 'uapkg.json'), JSON.stringify(project));
    await writeFile(join(directory, 'uapkg.lock'), JSON.stringify(lock));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps the bytes of a valid lock across frozen, regular, and deferred update operations', async () => {
    for (const options of [{ frozen: true }, {}, { updateTargets: [] }]) {
      const result = await pm.installWithReport({ ...options, nowMs: now * 1000 });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (result.ok && options.updateTargets) {
        expect(result.value.heldBack).toMatchObject([
          { name: 'mesh', selectedVersion: '1.0.1', blockedVersion: '1.0.2' },
        ]);
      }
      expect(await readFile(join(directory, 'uapkg.lock'), 'utf8')).toBe(JSON.stringify(lock));
    }
  });

  it('repairs stale edges without upgrading their valid locked parent', async () => {
    const stale = LockfileSchema.parse(lock);
    Object.values(stale.packages)[0].dependencies = { orphan: '1.2.3' };
    await pm.writeLockfile(stale);
    expect((await pm.install({ frozen: true })).ok).toBe(false);
    const repaired = await pm.install({ nowMs: now * 1000 });
    expect(repaired.ok && repaired.value).toEqual(lock);
  });

  it('refuses frozen graph repair but persists the compatible downgrade required by an explicit manifest edit', async () => {
    const registry = {
      getPackageManifest: async (name: string) =>
        ok({
          name,
          versions:
            name === 'terrain'
              ? {
                  '1.1.0': { ...published(123), dependencies: { mesh: { version: '1.0.0' } } },
                  '1.2.0': { ...published(123), dependencies: { mesh: { version: '2.0.0' } } },
                }
              : { '1.0.0': published(123), '2.0.0': published(123) },
        }),
    };
    pm = new PackageManifest({
      manifestRoot: directory,
      registryCore: { getOrCreateRegistry: () => ok(registry) } as unknown as RegistryCore,
    });
    const edited = { ...project, dependencies: { terrain: '^1.0.0', mesh: '1.0.0' } };
    const previous = LockfileSchema.parse({
      lockfileVersion: 1,
      packages: {
        terrain: { registry: 'default', version: '1.2.0', integrity: hash, gitTree, dependencies: { mesh: '2.0.0' } },
        mesh: { registry: 'default', version: '2.0.0', integrity: hash, gitTree },
      },
    });
    await writeFile(join(directory, 'uapkg.json'), JSON.stringify(edited));
    await writeFile(join(directory, 'uapkg.lock'), JSON.stringify(previous));

    const frozen = await pm.installWithReport({ frozen: true, nowMs: now * 1000 });
    expect(frozen.ok).toBe(false);
    expect(await readFile(join(directory, 'uapkg.json'), 'utf8')).toBe(JSON.stringify(edited));
    expect(await readFile(join(directory, 'uapkg.lock'), 'utf8')).toBe(JSON.stringify(previous));

    const repaired = await pm.installWithReport({ nowMs: now * 1000 });
    expect(repaired.ok, JSON.stringify(repaired.diagnostics)).toBe(true);
    const persisted = await pm.readLockfile();
    expect(persisted).toMatchObject({
      ok: true,
      value: {
        packages: {
          terrain: { version: '1.1.0', registry: 'default', dependencies: { mesh: '1.0.0' } },
          mesh: { version: '1.0.0', registry: 'default' },
        },
      },
    });
    expect(persisted.ok && Object.keys(persisted.value.packages).sort()).toEqual(['mesh', 'terrain']);
    expect(repaired.ok && repaired.value.heldBack).toEqual([]);
    expect(await readFile(join(directory, 'uapkg.json'), 'utf8')).toBe(JSON.stringify(edited));
  });

  it('reports actual wanted/latest versions even when the update is held back', async () => {
    const result = await pm.checkOutdated();
    expect(result.ok && result.value).toMatchObject([
      { name: 'mesh', current: '1.0.1', wanted: '1.0.2', latest: '1.0.2' },
    ]);
    expect(await readFile(join(directory, 'uapkg.lock'), 'utf8')).toBe(JSON.stringify(lock));
  });

  it('rejects modified integrity even with an age override and preserves the original files', async () => {
    const tampered = LockfileSchema.parse({
      ...lock,
      packages: { mesh: { ...lock.packages.mesh, integrity: `sha256:${'e'.repeat(64)}` } },
    });
    await pm.writeLockfile(tampered);
    const result = await pm.installWithReport({ ignoreReleaseAge: true });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('INTEGRITY_MISMATCH');
    expect(await pm.readLockfile()).toMatchObject({ ok: true, value: tampered });
  });

  it('leaves both inputs untouched when a staged manifest cannot resolve', async () => {
    const stagedManifest = ManifestSchema.parse({ ...project, dependencies: { mesh: '^2.0.0' } });
    const result = await pm.installWithReport({ stagedManifest });
    expect(result.ok).toBe(false);
    expect(await readFile(join(directory, 'uapkg.json'), 'utf8')).toBe(JSON.stringify(project));
    expect(await readFile(join(directory, 'uapkg.lock'), 'utf8')).toBe(JSON.stringify(lock));
  });

  it('restores original manifest and lock bytes when the lock replacement fails after resolution', async () => {
    const stagedManifest = ManifestSchema.parse({ ...project, dependencies: { mesh: '^1.0.2' } });
    const rename = fs.rename;
    let failedLock = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!failedLock && String(to) === join(directory, 'uapkg.lock')) {
        failedLock = true;
        throw Object.assign(new Error('Simulated locked file'), { code: 'EACCES' });
      }
      return rename(from, to);
    });
    const result = await pm.installWithReport({ stagedManifest, nowMs: now * 1000 });
    expect(failedLock).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('MANIFEST_WRITE_ERROR');
    expect(await readFile(join(directory, 'uapkg.json'), 'utf8')).toBe(JSON.stringify(project));
    expect(await readFile(join(directory, 'uapkg.lock'), 'utf8')).toBe(JSON.stringify(lock));
    expect(await readdir(directory)).toEqual(expect.arrayContaining(['uapkg.json', 'uapkg.lock']));
    expect((await readdir(directory)).filter((name) => name.startsWith('.uapkg.'))).toEqual([]);
  });

  it('updates existing symlink destinations while preserving links and staging on each destination volume', async (context) => {
    const manifestTarget = join(directory, 'manifest-target', 'project.json');
    const lockTarget = join(directory, 'lock-target', 'project.lock');
    await fs.mkdir(dirname(manifestTarget));
    await fs.mkdir(dirname(lockTarget));
    await fs.rename(join(directory, 'uapkg.json'), manifestTarget);
    await fs.rename(join(directory, 'uapkg.lock'), lockTarget);
    try {
      await fs.symlink(manifestTarget, join(directory, 'uapkg.json'), 'file');
      await fs.symlink(lockTarget, join(directory, 'uapkg.lock'), 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        context.skip();
        return;
      }
      throw error;
    }
    const rename = fs.rename;
    const replacements: Array<{ from: string; to: string }> = [];
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      replacements.push({ from: String(from), to: String(to) });
      return rename(from, to);
    });
    const stagedManifest = ManifestSchema.parse({ ...project, dependencies: { mesh: '^1.0.2' } });
    const result = await pm.installWithReport({ stagedManifest, nowMs: now * 1000 });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    expect((await fs.lstat(join(directory, 'uapkg.json'))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(join(directory, 'uapkg.lock'))).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(join(directory, 'uapkg.json'))).toBe(manifestTarget);
    expect(await fs.readlink(join(directory, 'uapkg.lock'))).toBe(lockTarget);
    expect(JSON.parse(await readFile(manifestTarget, 'utf8')).dependencies.mesh).toBe('^1.0.2');
    expect(JSON.parse(await readFile(lockTarget, 'utf8')).packages.mesh.version).toBe('1.0.2');
    expect(replacements).toHaveLength(2);
    for (const replacement of replacements) expect(dirname(replacement.from)).toBe(dirname(replacement.to));
    expect(await readdir(dirname(manifestTarget))).toEqual(['project.json']);
    expect(await readdir(dirname(lockTarget))).toEqual(['project.lock']);
  });
});
