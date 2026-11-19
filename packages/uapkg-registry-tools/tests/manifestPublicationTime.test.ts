import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PackageRegistryManifestSchema } from '@uapkg/registry-schema';
import { expect, it } from 'vite-plus/test';
import { getRegistryToolsAggregator, ManifestStore, RegistryRepoPaths } from '../src/index.ts';

it('rejects an undated registry write before overwriting a valid package file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uapkg-registry-writer-'));
  try {
    const store = new ManifestStore(new RegistryRepoPaths(directory), getRegistryToolsAggregator());
    const manifest = PackageRegistryManifestSchema.parse({
      name: 'mesh',
      packageSource: { type: 'git', url: 'https://example.test/mesh' },
      versions: {
        '1.0.0': {
          meta: { publishedAt: 42 },
          releaseFiles: {
            package: {
              url: 'https://example.test/mesh.tgz',
              integrity: { hash: `sha256:${'a'.repeat(64)}`, size: 10 },
            },
          },
        },
      },
    });
    const saved = await store.write(manifest);
    expect(saved.ok).toBe(true);
    const file = store.resolveManifestPath(manifest.name);
    const before = await readFile(file, 'utf8');

    // A JavaScript caller can supply a release with no publication timestamp.
    Reflect.deleteProperty(Object.values(manifest.versions)[0], 'meta');
    const refused = await store.write(manifest);
    expect(refused.ok).toBe(false);
    expect(refused.diagnostics).toMatchObject([{ code: 'SCHEMA_INVALID' }]);
    expect(await readFile(file, 'utf8')).toBe(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
