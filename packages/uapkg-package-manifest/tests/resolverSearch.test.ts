import { createPackageNotFoundDiagnostic, fail, ok } from '@uapkg/diagnostics';
import { VersionRangeSchema } from '@uapkg/common-schema';
import { LockfileSchema, ManifestSchema } from '@uapkg/package-manifest-schema';
import { SemverSelectionPolicy, type PackageRegistryManifest, type RegistryCore } from '@uapkg/registry-core';
import { PackageRegistryManifestSchema } from '@uapkg/registry-schema';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { ResolverOptions } from '../src/contracts/ManifestTypes.ts';
import { Resolver } from '../src/resolver/Resolver.ts';
import { ResolutionSearch, type Requirement } from '../src/resolver/ResolutionSearch.ts';

const now = 1_800_000_000;
const hash = `sha256:${'c'.repeat(64)}`;

function entry(dependencies: Record<string, string> = {}, age = 864_000) {
  return {
    private: false,
    meta: { publishedAt: now - age },
    dependencies,
    releaseFiles: { package: { url: 'https://example.test/package.tgz', integrity: { hash, size: 1 } } },
  };
}

function fixture(packages: Record<string, Record<string, ReturnType<typeof entry>>>) {
  const manifests = new Map<string, PackageRegistryManifest>(
    Object.entries(packages).map(([name, versions]) => [
      name,
      PackageRegistryManifestSchema.parse({
        name,
        versions,
        packageSource: { type: 'git', url: 'https://example.test/source' },
      }),
    ]),
  );
  const read = vi.fn(async (name: string) => {
    const manifest = manifests.get(name);
    return manifest ? ok(manifest) : fail([createPackageNotFoundDiagnostic(name, 'default')]);
  });
  return { read, core: { getOrCreateRegistry: () => ok({ getPackageManifest: read }) } as unknown as RegistryCore };
}

function lock(versions: Record<string, string>) {
  return LockfileSchema.parse({
    lockfileVersion: 1,
    packages: Object.fromEntries(
      Object.entries(versions).map(([name, version]) => [
        name,
        {
          version,
          registry: 'default',
          integrity: hash,
        },
      ]),
    ),
  });
}

function resolve(
  f: ReturnType<typeof fixture>,
  dependencies: Record<string, string>,
  options: ResolverOptions = {},
  kind = 'project',
) {
  return new Resolver(f.core).resolve(ManifestSchema.parse({ kind, name: 'game', version: '0.1.0', dependencies }), {
    nowMs: now * 1000,
    ...options,
  });
}

function selected(result: Awaited<ReturnType<typeof resolve>>) {
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) throw new Error('No solution');
  return Object.fromEntries([...result.value.nodes.values()].map((node) => [node.name, node.version]));
}

describe('flat graph cooldown search', () => {
  it('intersects root buckets, keeps roots unique, and applies effective overrides first', async () => {
    const f = fixture({ alpha: { '1.2.0': entry(), '1.8.0': entry(), '2.0.0': entry() } });
    const manifest = ManifestSchema.parse({
      kind: 'project',
      name: 'game',
      version: '0.1.0',
      dependencies: { alpha: '^1.0.0' },
      devDependencies: { alpha: '>=1.5.0 <2.0.0' },
    });
    const result = await new Resolver(f.core).resolve(manifest, { nowMs: now * 1000 });
    expect(selected(result)).toEqual({ alpha: '1.8.0' });
    if (result.ok) expect(result.value.roots).toHaveLength(1);
    const overridden = await new Resolver(f.core).resolve(manifest, {
      nowMs: now * 1000,
      overrides: { alpha: { version: VersionRangeSchema.parse('*') } },
    });
    expect(selected(overridden)).toEqual({ alpha: '2.0.0' });
  });

  it('honors an explicit exact CLI binding through a compatible broader override', async () => {
    const f = fixture({ alpha: { '0.5.0': entry(), '1.0.0': entry({}, 30), '2.0.0': entry() } });
    const result = await resolve(
      f,
      { alpha: '1.0.0' },
      {
        overrides: { alpha: { version: VersionRangeSchema.parse('*') } },
        requiredVersions: { alpha: '1.0.0' },
        previousLockfile: lock({ alpha: '0.5.0' }),
      },
    );
    expect(selected(result)).toEqual({ alpha: '1.0.0' });
  });
  it.each(['project', 'plugin'])('uses a literal direct floor in a local %s manifest', async (kind) => {
    const f = fixture({ alpha: { '1.7.2': entry({}, 60), '1.7.3': entry({}, 30) } });
    const result = await resolve(f, { alpha: '^1.7.2' }, {}, kind);
    expect(selected(result)).toEqual({ alpha: '1.7.2' });
    if (result.ok)
      expect(result.value.heldBack).toMatchObject([
        { name: 'alpha', selectedVersion: '1.7.2', blockedVersion: '1.7.3' },
      ]);
  });

  it.each(['1.0.0+foo', 'v1.0.0+foo', '=v1.0.0+foo'])(
    'honors exact artifact %s without choosing another build',
    async (range) => {
      const f = fixture({ alpha: { '1.0.0+foo': entry({}, 30), '1.0.0+bar': entry() } });
      expect(selected(await resolve(f, { alpha: range }))).toEqual({ alpha: '1.0.0+foo' });
    },
  );

  it('reports all age-filtered matches when a synthetic minimum cannot bypass cooldown', async () => {
    const result = await resolve(fixture({ alpha: { '1.7.2': entry({}, 60), '1.7.3': entry({}, 30) } }), {
      alpha: '^1.7',
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toMatchObject([
      {
        code: 'RELEASE_AGE_BLOCKED',
        data: {
          packageName: 'alpha',
          candidates: [{ version: '1.7.3' }, { version: '1.7.2' }],
        },
      },
    ]);
  });

  it('does not let a transitive exact version or a conflicting direct floor bypass age', async () => {
    const f = fixture({
      alpha: { '1.0.0': entry({ shared: '>=1.3.0' }) },
      shared: { '1.2.3': entry({}, 60), '1.3.0': entry({}, 30) },
    });
    const result = await resolve(f, { alpha: '*', shared: '^1.2.3' });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toMatchObject([
      { code: 'RELEASE_AGE_BLOCKED', data: { packageName: 'shared', candidates: [{ version: '1.3.0' }] } },
    ]);
  });

  it('keeps a compatible young lock instead of downgrading to the aged release', async () => {
    const f = fixture({ alpha: { '1.0.0': entry(), '2.0.0': entry({}, 60) } });
    const result = await resolve(f, { alpha: '*' }, { previousLockfile: lock({ alpha: '2.0.0' }), updateTargets: [] });
    expect(selected(result)).toEqual({ alpha: '2.0.0' });
    if (result.ok) expect(result.value.heldBack).toEqual([]);
  });

  it('reuses a valid lock without evaluating age for any available releases', async () => {
    const f = fixture({ alpha: { '1.0.0': entry({}, 60), '2.0.0': entry({}, 30) } });
    const age = vi.spyOn(ResolutionSearch.prototype, 'ageAllowed').mockImplementation(() => {
      throw new Error('A valid lock does not consult release age');
    });
    try {
      const result = await resolve(f, { alpha: '*' }, { previousLockfile: lock({ alpha: '1.0.0' }) });
      expect(selected(result)).toEqual({ alpha: '1.0.0' });
      expect(age).not.toHaveBeenCalled();
      if (result.ok) expect(result.value.heldBack).toEqual([]);
    } finally {
      age.mockRestore();
    }
  });

  it('does not downgrade a compatible parent lock to erase a protected shared path', async () => {
    const f = fixture({
      fresh: { '1.0.0': entry({ shared: '*' }, 30) },
      protected: { '1.0.0': entry(), '2.0.0': entry({ nested: '*' }) },
      nested: { '1.0.0': entry({ shared: '2.0.0' }) },
      shared: { '1.0.0': entry(), '2.0.0': entry({}, 30) },
    });
    const result = await resolve(
      f,
      { fresh: '*', protected: '*' },
      {
        newRoots: ['fresh'],
        requiredVersions: { fresh: '1.0.0' },
        previousLockfile: lock({ protected: '2.0.0', nested: '1.0.0', shared: '1.0.0' }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toMatchObject([{ code: 'RELEASE_AGE_BLOCKED', data: { packageName: 'shared' } }]);
  });

  it.each([false, true])(
    'reconsiders provisional lower candidates after a late edge invalidates the old lock, override=%s',
    async (ignoreReleaseAge) => {
      const f = fixture({
        alpha: { '1.0.0': entry(), '2.0.0': entry() },
        zeta: { '1.0.0': entry({ nested: '*' }) },
        nested: { '1.0.0': entry({ alpha: '^1.0.0' }) },
      });
      expect(
        selected(
          await resolve(f, { alpha: '*', zeta: '*' }, { previousLockfile: lock({ alpha: '2.0.0' }), ignoreReleaseAge }),
        ),
      ).toEqual({ alpha: '1.0.0', zeta: '1.0.0', nested: '1.0.0' });
    },
  );

  it('repairs a compatible parent lock only when an explicit declaration makes its old graph impossible', async () => {
    const f = fixture({
      terrain: { '1.1.0': entry({ mesh: '1.0.0' }), '1.2.0': entry({ mesh: '2.0.0' }) },
      mesh: { '1.0.0': entry(), '2.0.0': entry() },
    });
    const options = { previousLockfile: lock({ terrain: '1.2.0', mesh: '2.0.0' }) };
    expect(selected(await resolve(f, { terrain: '^1.0.0', mesh: '1.0.0' }, options))).toEqual({
      terrain: '1.1.0',
      mesh: '1.0.0',
    });
    const frozen = await resolve(f, { terrain: '^1.0.0', mesh: '1.0.0' }, { ...options, frozen: true });
    expect(frozen.ok).toBe(false);
    expect(frozen.diagnostics.some((diagnostic) => diagnostic.code === 'RELEASE_AGE_BLOCKED')).toBe(false);
  });

  it('does not downgrade a compatible parent merely because its child is too young', async () => {
    const f = fixture({
      alpha: { '1.0.0': entry(), '2.0.0': entry({ child: '2.0.0' }) },
      child: { '2.0.0': entry({}, 30) },
    });
    const result = await resolve(f, { alpha: '*' }, { previousLockfile: lock({ alpha: '2.0.0' }) });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toMatchObject([{ code: 'RELEASE_AGE_BLOCKED', data: { packageName: 'child' } }]);
  });

  it('does not spend an extra parent downgrade on cooldown while repairing an unrelated manifest change', async () => {
    const f = fixture({
      terrain: { '1.1.0': entry({ mesh: '1.0.0' }), '1.2.0': entry({ mesh: '2.0.0' }) },
      mesh: { '1.0.0': entry(), '2.0.0': entry() },
      alpha: { '1.0.0': entry(), '2.0.0': entry({ child: '2.0.0' }) },
      child: { '2.0.0': entry({}, 30) },
    });
    const result = await resolve(
      f,
      { terrain: '^1.0.0', mesh: '1.0.0', alpha: '*' },
      {
        previousLockfile: lock({ terrain: '1.2.0', mesh: '2.0.0', alpha: '2.0.0' }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toMatchObject([{ code: 'RELEASE_AGE_BLOCKED', data: { packageName: 'child' } }]);
  });

  it('omits unrelated stale-lock resolutions from a named update held-back summary', async () => {
    const f = fixture({
      alpha: { '1.0.0': entry(), '1.1.0': entry() },
      unrelated: { '1.0.0': entry(), '2.0.0': entry({}, 30) },
    });
    const result = await resolve(
      f,
      { alpha: '*', unrelated: '*' },
      {
        previousLockfile: lock({ alpha: '1.0.0' }),
        updateTargets: ['alpha'],
      },
    );
    expect(selected(result)).toEqual({ alpha: '1.1.0', unrelated: '1.0.0' });
    if (result.ok) expect(result.value.heldBack).toEqual([]);
  });

  it.each([
    [{ updateTargets: ['alpha'] }, '1.0.0'],
    [{ updateTargets: ['alpha'], recursive: true }, '1.1.0'],
    [{ updateTargets: [] }, '1.1.0'],
  ] as const)('respects targeted versus complete update scope %j', async (scope, expected) => {
    const f = fixture({
      alpha: { '1.0.0': entry({ child: '^1.0.0' }) },
      child: { '1.0.0': entry(), '1.1.0': entry() },
    });
    const result = await resolve(
      f,
      { alpha: '*' },
      { ...scope, previousLockfile: lock({ alpha: '1.0.0', child: '1.0.0' }) },
    );
    expect(selected(result).child).toBe(expected);
  });

  it('keeps frozen selections exact and refuses to acquire an unlocked child', async () => {
    const f = fixture({
      alpha: { '1.0.0': entry({ child: '*' }, 60), '2.0.0': entry() },
      child: { '1.0.0': entry({}, 60) },
    });
    const missing = await resolve(f, { alpha: '*' }, { frozen: true, previousLockfile: lock({ alpha: '1.0.0' }) });
    expect(missing.ok).toBe(false);
    expect(missing.diagnostics.some((diagnostic) => diagnostic.code === 'RELEASE_AGE_BLOCKED')).toBe(false);
    expect(
      selected(
        await resolve(f, { alpha: '*' }, { frozen: true, previousLockfile: lock({ alpha: '1.0.0', child: '1.0.0' }) }),
      ),
    ).toEqual({ alpha: '1.0.0', child: '1.0.0' });
  });

  it('bypasses age throughout a genuinely new tree, but binds the actual preflight root', async () => {
    const f = fixture({
      alpha: { '1.0.0': entry(), '2.0.0': entry({ child: '*' }, 30) },
      child: { '1.0.0': entry({ leaf: '*' }, 30) },
      leaf: { '1.0.0': entry({}, 30) },
    });
    expect(
      selected(await resolve(f, { alpha: '^2.0.0' }, { newRoots: ['alpha'], requiredVersions: { alpha: '2.0.0' } })),
    ).toEqual({ alpha: '2.0.0', child: '1.0.0', leaf: '1.0.0' });
  });

  it('does not treat an inherited requiredVersions property as an exact selection', async () => {
    expect(
      selected(
        await resolve(fixture({ constructor: { '1.0.0': entry() } }), { constructor: '*' }, { requiredVersions: {} }),
      ),
    ).toEqual({ constructor: '1.0.0' });
  });

  it('keeps prefix-related package identities separate', async () => {
    expect(
      selected(
        await resolve(fixture({ foo: { '2.0.0': entry() }, 'foo-bar': { '1.0.0': entry() } }), {
          foo: '*',
          'foo-bar': '*',
        }),
      ),
    ).toEqual({ foo: '2.0.0', 'foo-bar': '1.0.0' });
  });

  it('does not label an intrinsically missing package as a cooldown failure', async () => {
    const result = await resolve(
      fixture({ alpha: { '1.0.0': entry({ missing: '*' }), '2.0.0': entry({ missing: '*' }, 30) } }),
      { alpha: '*' },
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toMatchObject([{ code: 'PACKAGE_NOT_FOUND' }]);
  });

  it('prunes unrelated roots rather than exploring their Cartesian product', async () => {
    const packages: Record<string, Record<string, ReturnType<typeof entry>>> = {};
    for (let index = 0; index < 10; index++)
      packages[`library-${index}`] = Object.fromEntries(
        Array.from({ length: 15 }, (_, version) => [`1.${version}.0`, entry()]),
      );
    packages.zeta = { '1.0.0': entry({ missing: '*' }) };
    const f = fixture(packages);
    const roots: Requirement[] = Object.keys(packages).map((name) => ({
      name,
      registry: 'default',
      range: '*',
      root: name,
      direct: true,
      newTree: false,
    }));
    const search = new ResolutionSearch(f.core, roots, {}, 259_200_000, now * 1000);
    expect('diagnostics' in (await search.solve(false))).toBe(true);
    expect(search.exploredStates).toBeLessThan(30);
    expect(search.repairBudget).toBe(Number.POSITIVE_INFINITY);
    expect(f.read).toHaveBeenCalledTimes(12);
  });

  it('ranks equivalent demands once per operation instead of at every search depth', async () => {
    const packages = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `library-${index}`,
        Object.fromEntries(Array.from({ length: 20 }, (_, version) => [`1.${version}.0`, entry()])),
      ]),
    );
    const f = fixture(packages);
    const ranking = vi.spyOn(SemverSelectionPolicy.prototype, 'rankCandidates');
    try {
      const result = await resolve(f, Object.fromEntries(Object.keys(packages).map((name) => [name, '*'])), {
        updateTargets: [],
      });
      expect(result.ok).toBe(true);
      expect(ranking).toHaveBeenCalledTimes(12);
    } finally {
      ranking.mockRestore();
    }
  });

  it('reports the longest blocking child wait against its deferred parent upgrade', async () => {
    const f = fixture({
      alpha: { '1.0.0': entry(), '2.0.0': entry({ first: '*', second: '*' }) },
      first: { '1.0.0': entry({}, 60) },
      second: { '1.0.0': entry({}, 30) },
    });
    const result = await resolve(f, { alpha: '*' }, { previousLockfile: lock({ alpha: '1.0.0' }), updateTargets: [] });
    expect(selected(result)).toEqual({ alpha: '1.0.0' });
    if (result.ok)
      expect(result.value.heldBack).toEqual([
        {
          name: 'alpha',
          registry: 'default',
          selectedVersion: '1.0.0',
          blockedVersion: '2.0.0',
          blockedDependency: { name: 'second', version: '1.0.0' },
          publishedAt: now - 30,
          eligibleInSeconds: 259_170,
        },
      ]);
  });

  it.each([false, true])(
    'attributes a shared blocking child to every deferred parent, child already selected=%s',
    async (alreadySelected) => {
      const before: Record<string, string> = alreadySelected ? { child: '^1.0.0' } : {};
      const f = fixture({
        alpha: { '1.0.0': entry(before), '2.0.0': entry({ child: '^2.0.0' }) },
        beta: { '1.0.0': entry(before), '2.0.0': entry({ child: '^2.0.0' }) },
        child: { '1.0.0': entry(), '2.0.0': entry({}, 30) },
      });
      const result = await resolve(
        f,
        { alpha: '*', beta: '*' },
        {
          previousLockfile: lock({ alpha: '1.0.0', beta: '1.0.0', ...(alreadySelected ? { child: '1.0.0' } : {}) }),
          updateTargets: [],
        },
      );
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (result.ok)
        expect(result.value.heldBack).toMatchObject([
          {
            name: 'alpha',
            selectedVersion: '1.0.0',
            blockedVersion: '2.0.0',
            blockedDependency: { name: 'child', version: '2.0.0' },
          },
          {
            name: 'beta',
            selectedVersion: '1.0.0',
            blockedVersion: '2.0.0',
            blockedDependency: { name: 'child', version: '2.0.0' },
          },
        ]);
    },
  );
});
