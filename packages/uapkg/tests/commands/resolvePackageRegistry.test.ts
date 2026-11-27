import { createPackageNotFoundDiagnostic, createRegistryNotFoundDiagnostic, fail, ok } from '@uapkg/diagnostics';
import { ManifestSchema } from '@uapkg/package-manifest-schema';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { CompositionRoot } from '../../src/app/CompositionRoot.ts';
import { resolvePackageRegistry } from '../../src/commands/resolvePackageRegistry.ts';

describe('resolving an omitted package registry', () => {
  const name = 'effects';
  const manifest = ManifestSchema.parse({
    kind: 'project',
    name: 'game',
    version: '1.0.0',
    dependencies: { elsewhere: { version: '*', registry: 'unrelated' } },
    devDependencies: { effects: { version: '*', registry: 'studio' } },
    overrides: { effects: { version: '*', registry: 'internal' } },
  });
  function catalog() {
    const getPackageManifest = vi.fn();
    const getOrCreateRegistry = vi.fn(() => ok({ getPackageManifest }));
    const root = { registryCore: { getOrCreateRegistry } } as unknown as Pick<CompositionRoot, 'registryCore'>;
    return { root, getOrCreateRegistry, getPackageManifest };
  }

  it('lists only the registries declared for this package, after confirming it exists in default', async () => {
    const { root, getPackageManifest } = catalog();
    getPackageManifest.mockResolvedValue(ok({}));
    const result = await resolvePackageRegistry(root, manifest, name);
    expect(getPackageManifest).toHaveBeenCalledExactlyOnceWith(name, 'default');
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'PACKAGE_REGISTRY_AMBIGUOUS',
          data: {
            packageName: name,
            registries: ['default', 'internal', 'studio'],
          },
        },
      ],
    });
  });

  it('keeps the default selection on a confirmed miss and preserves catalog failures', async () => {
    const { root, getPackageManifest } = catalog();
    const unavailable = fail([createRegistryNotFoundDiagnostic('default')]);
    getPackageManifest
      .mockResolvedValueOnce(fail([createPackageNotFoundDiagnostic(name, 'default')]))
      .mockResolvedValueOnce(unavailable);
    expect(await resolvePackageRegistry(root, manifest, name)).toEqual(ok('default'));
    expect(await resolvePackageRegistry(root, manifest, name)).toEqual(unavailable);
  });

  it('recognizes a package listed only in a saved release permission', async () => {
    const { root, getPackageManifest } = catalog();
    getPackageManifest.mockResolvedValue(ok({}));
    const workspace = ManifestSchema.parse({
      kind: 'project',
      name: 'game',
      version: '1.0.0',
      permissions: {
        releases: [
          {
            packageName: name,
            registry: 'studio',
            registryId: 'a'.repeat(64),
            version: '1.0.0',
            integrity: 'sha256:' + 'b'.repeat(64),
            capabilities: ['integration'],
          },
        ],
      },
    });
    expect(await resolvePackageRegistry(root, workspace, name)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'PACKAGE_REGISTRY_AMBIGUOUS', data: { registries: ['default', 'studio'] } }],
    });
  });

  it('accepts explicit selections and ordinary defaults without consulting the catalog', async () => {
    const { root, getOrCreateRegistry } = catalog();
    expect(await resolvePackageRegistry(root, manifest, name, 'studio')).toEqual(ok('studio'));
    expect(await resolvePackageRegistry(root, manifest, name, 'default')).toEqual(ok('default'));
    expect(await resolvePackageRegistry(root, manifest, 'another')).toEqual(ok('default'));
    expect(await resolvePackageRegistry(root, undefined, name)).toEqual(ok('default'));
    expect(getOrCreateRegistry).not.toHaveBeenCalled();
  });
});
