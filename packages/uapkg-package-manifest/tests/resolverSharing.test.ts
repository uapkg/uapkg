import { createPackageNotFoundDiagnostic, fail, ok } from '@uapkg/diagnostics';
import { LockfileSchema, ManifestSchema } from '@uapkg/package-manifest-schema';
import type { RegistryCore } from '@uapkg/registry-core';
import { PackageRegistryManifestSchema, type PackageRegistryManifest } from '@uapkg/registry-schema';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { ResolverOptions } from '../src/contracts/ManifestTypes.ts';
import { Resolver } from '../src/resolver/Resolver.ts';

const now = 1_800_000_000;
const hash = `sha256:${'b'.repeat(64)}`;
const tree = 'a'.repeat(40);

function entry(dependencies: Record<string, string> = {}, ageSeconds = 864_000) {
  return {
    gitTree: tree,
    private: false,
    meta: { publishedAt: now - ageSeconds },
    dependencies,
    releaseFiles: { package: { url: 'https://example.test/plugin.tgz', integrity: { hash, size: 10 } } },
  };
}

function registry(packages: Record<string, Record<string, ReturnType<typeof entry>>>) {
  const manifests = new Map<string, PackageRegistryManifest>(
    Object.entries(packages).map(([name, versions]) => [
      name,
      PackageRegistryManifestSchema.parse({
        name,
        packageSource: { type: 'git', url: 'https://example.test/source' },
        versions,
      }),
    ]),
  );
  const read = vi.fn(async (name: string) => {
    const manifest = manifests.get(name);
    return manifest ? ok(manifest) : fail([createPackageNotFoundDiagnostic(name, 'default')]);
  });
  return { core: { getOrCreateRegistry: () => ok({ getPackageManifest: read }) } as unknown as RegistryCore, read };
}

function previous(versions: Record<string, string>) {
  return LockfileSchema.parse({
    lockfileVersion: 1,
    packages: Object.fromEntries(
      Object.entries(versions).map(([name, version]) => [
        name,
        { version, registry: 'default', integrity: hash, gitTree: tree },
      ]),
    ),
  });
}

async function resolve(
  fixture: ReturnType<typeof registry>,
  dependencies: Record<string, string>,
  options: ResolverOptions = {},
) {
  return new Resolver(fixture.core).resolve(
    ManifestSchema.parse({ kind: 'project', name: 'game', version: '0.0.1', dependencies }),
    { nowMs: now * 1000, ...options },
  );
}

function versions(result: Awaited<ReturnType<typeof resolve>>) {
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) throw new Error('Expected a feasible graph');
  return Object.fromEntries([...result.value.nodes.values()].map((node) => [node.name, node.version]));
}

describe('shared graph release age provenance', () => {
  it.each([
    ['alpha', 'zeta'],
    ['zeta', 'alpha'],
  ])('keeps a shared descendant protected when adding %s to a project that has %s', async (newRoot, existingRoot) => {
    const fixture = registry({
      [newRoot]: { '1.0.0': entry({ shared: '^1.0.0' }, 60) },
      [existingRoot]: { '1.0.0': entry({ left: '1.0.0', right: '1.0.0' }) },
      left: { '1.0.0': entry({ shared: '^1.0.0' }) },
      right: { '1.0.0': entry({ shared: '^1.0.0' }) },
      shared: { '1.0.0': entry(), '1.1.0': entry({}, 60) },
    });
    const result = await resolve(
      fixture,
      { [existingRoot]: '*', [newRoot]: '*' },
      {
        newRoots: [newRoot],
        applyReleaseAgeToNewPackages: false,
        previousLockfile: previous({ [existingRoot]: '1.0.0' }),
      },
    );
    expect(versions(result)).toEqual({
      [newRoot]: '1.0.0',
      [existingRoot]: '1.0.0',
      left: '1.0.0',
      right: '1.0.0',
      shared: '1.0.0',
    });
    expect(fixture.read.mock.calls.filter(([name]) => name === 'shared')).toHaveLength(1);
  });

  it('propagates recursive update scope from a later shared path', async () => {
    const fixture = registry({
      alpha: { '1.0.0': entry({ shared: '^1.0.0' }) },
      zeta: { '1.0.0': entry({ shared: '^1.0.0' }), '1.1.0': entry({ shared: '^1.0.0' }) },
      shared: { '1.0.0': entry(), '1.1.0': entry() },
    });
    const result = await resolve(
      fixture,
      { alpha: '^1.0.0', zeta: '^1.0.0' },
      {
        previousLockfile: previous({ alpha: '1.0.0', zeta: '1.0.0', shared: '1.0.0' }),
        updateTargets: ['zeta'],
        recursive: true,
      },
    );
    expect(versions(result)).toEqual({ alpha: '1.0.0', zeta: '1.1.0', shared: '1.1.0' });
  });

  it('stops new-tree exemptions when a repeated path crosses a previous lock', async () => {
    const fixture = registry({
      fresh: { '1.0.0': entry({ existing: '^1.0.0', novel: '^1.0.0' }, 60) },
      existing: { '1.0.0': entry({ shared: '^1.0.0' }) },
      novel: { '1.0.0': entry({ shared: '^1.0.0' }, 60) },
      shared: { '1.0.0': entry(), '1.1.0': entry({}, 60) },
    });
    const result = await resolve(
      fixture,
      { fresh: '*' },
      {
        newRoots: ['fresh'],
        applyReleaseAgeToNewPackages: false,
        requiredVersions: { fresh: '1.0.0' },
        previousLockfile: previous({ existing: '1.0.0' }),
      },
    );
    expect(versions(result)).toEqual({ fresh: '1.0.0', existing: '1.0.0', novel: '1.0.0', shared: '1.0.0' });
    expect(fixture.read.mock.calls.filter(([name]) => name === 'shared')).toHaveLength(1);
  });

  it('prioritizes the highest feasible named target before optional changes to another root', async () => {
    const fixture = registry({
      alpha: { '1.0.0': entry({ shared: '^1.0.0' }), '1.1.0': entry({ shared: '^2.0.0' }) },
      zeta: { '1.0.0': entry({ shared: '^1.0.0' }), '1.1.0': entry({ shared: '^2.0.0' }) },
      shared: { '1.0.0': entry(), '2.0.0': entry() },
    });
    const result = await resolve(
      fixture,
      { alpha: '^1.0.0', zeta: '^1.0.0' },
      {
        previousLockfile: previous({ alpha: '1.0.0', zeta: '1.0.0', shared: '1.0.0' }),
        updateTargets: ['zeta'],
      },
    );
    expect(versions(result)).toEqual({ alpha: '1.1.0', zeta: '1.1.0', shared: '2.0.0' });
  });

  it('keeps unrelated compatible locks when they do not constrain the requested target', async () => {
    const fixture = registry({
      alpha: { '1.0.0': entry(), '1.1.0': entry() },
      zeta: { '1.0.0': entry(), '1.1.0': entry() },
    });
    const result = await resolve(
      fixture,
      { alpha: '^1.0.0', zeta: '^1.0.0' },
      {
        previousLockfile: previous({ alpha: '1.0.0', zeta: '1.0.0' }),
        updateTargets: ['zeta'],
      },
    );
    expect(versions(result)).toEqual({ alpha: '1.0.0', zeta: '1.1.0' });
  });

  it('attributes a parent hold to its new cooling descendant after branch rollback', async () => {
    const fixture = registry({
      parent: { '1.0.0': entry({ shared: '^1.0.0' }), '1.1.0': entry({ shared: '^2.0.0' }) },
      shared: { '1.0.0': entry(), '2.0.0': entry({}, 60) },
    });
    const result = await resolve(
      fixture,
      { parent: '^1.0.0' },
      {
        previousLockfile: previous({ parent: '1.0.0', shared: '1.0.0' }),
        updateTargets: ['parent'],
      },
    );
    expect(versions(result)).toEqual({ parent: '1.0.0', shared: '1.0.0' });
    if (!result.ok) return;
    expect(result.value.heldBack).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'parent',
          selectedVersion: '1.0.0',
          blockedVersion: '1.1.0',
          blockedDependency: { name: 'shared', version: '2.0.0' },
        }),
      ]),
    );
  });

  it('reports a cooling dependency introduced only by the blocked parent version', async () => {
    const fixture = registry({
      parent: { '1.0.0': entry({ legacy: '^1.0.0' }), '1.1.0': entry({ fresh: '^1.0.0' }) },
      legacy: { '1.0.0': entry() },
      fresh: { '1.0.0': entry({}, 60) },
    });
    const result = await resolve(
      fixture,
      { parent: '^1.0.0' },
      {
        previousLockfile: previous({ parent: '1.0.0', legacy: '1.0.0' }),
        updateTargets: ['parent'],
      },
    );
    expect(versions(result)).toEqual({ parent: '1.0.0', legacy: '1.0.0' });
    if (!result.ok) return;
    expect(result.value.heldBack).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'parent',
          selectedVersion: '1.0.0',
          blockedVersion: '1.1.0',
          blockedDependency: { name: 'fresh', version: '1.0.0' },
        }),
      ]),
    );
  });

  it('does not retain a failed parent branch or mislabel a real conflict as an age failure', async () => {
    const fixture = registry({
      parent: { '1.0.0': entry({ left: '*' }), '1.1.0': entry({ missing: '*' }) },
      left: { '1.0.0': entry() },
    });
    const result = await resolve(fixture, { parent: '^1.0.0' }, { updateTargets: [] });
    expect(versions(result)).toEqual({ parent: '1.0.0', left: '1.0.0' });
    if (result.ok) expect(result.value.heldBack).toEqual([]);
    const conflict = await resolve(
      registry({
        alpha: { '1.0.0': entry({ shared: '^1.0.0' }) },
        zeta: { '1.0.0': entry({ shared: '^2.0.0' }) },
        shared: { '1.0.0': entry(), '2.0.0': entry() },
      }),
      { alpha: '*', zeta: '*' },
    );
    expect(conflict.ok).toBe(false);
    expect(conflict.diagnostics.map((diagnostic) => diagnostic.code)).toContain('VERSION_CONFLICT');
    expect(conflict.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('RELEASE_AGE_BLOCKED');
  });
});
