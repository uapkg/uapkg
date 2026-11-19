import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { INTERNAL_PROFILE_HOME_ENV } from '@uapkg/common';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { getRegistryRepoPath } from '../src/paths/RegistryPaths.ts';
import { RegistryPackageReader } from '../src/registry/RegistryPackageReader.ts';
import {
  registryMetaFixture,
  type RegistryMetaFixtureFormat,
} from '../../uapkg-registry-schema/tests/fixtures/registryMetaFixture.ts';

const shortId = 'schema-context-test';
const previousProfileHome = process.env[INTERNAL_PROFILE_HOME_ENV];
let profileHome: string;

beforeEach(async () => {
  profileHome = await mkdtemp(join(tmpdir(), 'uapkg-registry-schema-context-'));
  process.env[INTERNAL_PROFILE_HOME_ENV] = profileHome;
});

afterEach(async () => {
  if (previousProfileHome === undefined) delete process.env[INTERNAL_PROFILE_HOME_ENV];
  else process.env[INTERNAL_PROFILE_HOME_ENV] = previousProfileHome;
  await rm(profileHome, { recursive: true, force: true });
});

describe.each(['reduced', 'rich'] as const)('RegistryPackageReader (%s metadata)', (format) => {
  it('requires gitTree for a public registry version', async () => {
    await writeRegistry('public', false, 1, format);

    const result = await new RegistryPackageReader(shortId).readPackageManifest('no-tree');

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('SCHEMA_INVALID');
  });

  it('allows a trusted private registry version to omit gitTree', async () => {
    await writeRegistry('private', false, 1, format);

    const result = await new RegistryPackageReader(shortId).readPackageManifest('no-tree');

    expect(result.ok).toBe(true);
  });

  it('accepts a public registry version with gitTree', async () => {
    await writeRegistry('public', true, 1, format);

    const result = await new RegistryPackageReader(shortId).readPackageManifest('no-tree');

    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.values(result.value.versions)[0].gitTree).toBe('a'.repeat(40));
  });

  it('fails closed when the registry metadata file is absent', async () => {
    await writeRegistry('private', false, 1, format);
    await rm(join(getRegistryRepoPath(shortId), '.uapkg', 'registry.meta.json'));

    const result = await new RegistryPackageReader(shortId).readPackageManifest('no-tree');

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('SCHEMA_INVALID');
  });

  it('fails closed when present metadata has an unknown schema version', async () => {
    await writeRegistry('private', false, 2, format);

    const result = await new RegistryPackageReader(shortId).readPackageManifest('no-tree');

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('SCHEMA_INVALID');
  });
});

async function writeRegistry(
  registryType: 'public' | 'private',
  includeGitTree: boolean,
  schemaVersion = 1,
  format: RegistryMetaFixtureFormat = 'reduced',
): Promise<void> {
  const repoPath = getRegistryRepoPath(shortId);
  const packagePath = join(repoPath, 'packages', 'n', 'no-tree.json');
  await mkdir(dirname(packagePath), { recursive: true });
  await mkdir(join(repoPath, '.uapkg'), { recursive: true });
  await writeFile(
    packagePath,
    JSON.stringify({
      name: 'no-tree',
      packageSource: { type: 'git', url: 'https://github.com/acme/no-tree' },
      versions: {
        '1.0.0': {
          meta: { publishedAt: 1_700_000_000 },
          ...(includeGitTree ? { gitTree: 'a'.repeat(40) } : {}),
          releaseFiles: {
            package: {
              url: 'https://example.test/no-tree.tgz',
              integrity: { hash: `sha256:${'b'.repeat(64)}`, size: 1 },
            },
          },
        },
      },
    }),
    'utf8',
  );
  await writeFile(
    join(repoPath, '.uapkg', 'registry.meta.json'),
    JSON.stringify(registryMetaFixture({ format, registryType, schemaVersion, name: 'Test registry' })),
    'utf8',
  );
}
