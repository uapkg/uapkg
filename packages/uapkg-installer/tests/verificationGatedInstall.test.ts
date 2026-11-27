import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '@uapkg/diagnostics';
import type { Lockfile } from '@uapkg/package-manifest-schema';
import type { RegistryCore } from '@uapkg/registry-core';
import { PackageRegistryManifestSchema } from '@uapkg/registry-schema';
import { c as createTar } from 'tar';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { Installer } from '../src/core/Installer.ts';
import {
  registryMetaFixture,
  type RegistryMetaFixtureFormat,
} from '../../uapkg-registry-schema/tests/fixtures/registryMetaFixture.ts';

interface FixtureArtifact {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

interface RegistryFixtureVersion {
  readonly artifact: FixtureArtifact;
  readonly recordDependencies?: Record<string, string>;
  readonly recordPrivate?: boolean;
  readonly omitGitTree?: boolean;
}

const artifacts = new Map<string, Buffer>();
const redirects = new Map<string, string>();
let server: Server;
let baseUrl: string;
const tempDirs: string[] = [];
const originalProfileHome = process.env.UAPKG_INTERNAL_CONFIG_CACHE_HOME;

beforeAll(async () => {
  server = createServer((req, res) => {
    const redirect = redirects.get(req.url ?? '');
    if (redirect) {
      res.statusCode = 302;
      res.setHeader('location', redirect);
      res.end();
      return;
    }
    const body = artifacts.get(req.url ?? '');
    if (!body) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-length', body.length);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await writeRegistryMeta('testshortid', 'private');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  artifacts.clear();
  redirects.clear();
  if (originalProfileHome === undefined) delete process.env.UAPKG_INTERNAL_CONFIG_CACHE_HOME;
  else process.env.UAPKG_INTERNAL_CONFIG_CACHE_HOME = originalProfileHome;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Build a tgz artifact whose packaged uapkg.json carries the given manifest. */
async function makeArtifact(
  name: string,
  version: string,
  manifest: Record<string, unknown>,
): Promise<FixtureArtifact> {
  const staging = await makeTempDir('uapkg-installer-fixture-');
  const prefix = `${name.replace('/', '-')}-${version}`;
  const contentRoot = join(staging, prefix);
  await mkdir(contentRoot, { recursive: true });
  await writeFile(join(contentRoot, 'uapkg.json'), JSON.stringify(manifest), 'utf8');
  await writeFile(join(contentRoot, 'payload.txt'), `content of ${name}@${version}`, 'utf8');
  const archivePath = join(staging, 'package.tgz');
  await createTar({ gzip: true, file: archivePath, cwd: staging, portable: true }, [prefix]);
  const bytes = await readFile(archivePath);
  const urlPath = `/artifacts/${encodeURIComponent(name)}-${version}.tgz`;
  artifacts.set(urlPath, bytes);
  return {
    url: `${baseUrl}${urlPath}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

/** Serve arbitrary bytes for a package, returning integrity computed from them. */
function serveRawArtifact(name: string, version: string, bytes: Buffer): FixtureArtifact {
  const urlPath = `/artifacts/${encodeURIComponent(name)}-${version}.tgz`;
  artifacts.set(urlPath, bytes);
  return {
    url: `${baseUrl}${urlPath}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

function buildRegistryCore(fixtures: Map<string, RegistryFixtureVersion>, shortId: string): RegistryCore {
  return {
    getOrCreateRegistry: () =>
      ok({
        shortId,
        id: createHash('sha256').update(shortId).digest('hex'),
        getPackageManifest: async (packageName: string) => {
          const versions: Record<string, unknown> = {};
          for (const [key, fixture] of fixtures) {
            const [name, version] = key.split('@@');
            if (name !== packageName) continue;
            versions[version] = {
              meta: { publishedAt: 1_700_000_000 },
              ...(fixture.omitGitTree ? {} : { gitTree: 'a'.repeat(40) }),
              private: fixture.recordPrivate ?? false,
              releaseFiles: {
                package: {
                  url: fixture.artifact.url,
                  integrity: {
                    hash: `sha256:${fixture.artifact.sha256}`,
                    size: fixture.artifact.size,
                  },
                },
              },
              ...(fixture.recordDependencies ? { dependencies: fixture.recordDependencies } : {}),
            };
          }
          if (Object.keys(versions).length === 0) {
            return ok(undefined as never);
          }
          // Parse like production so dependency declarations normalize identically.
          const parsed = PackageRegistryManifestSchema.parse({
            name: packageName,
            packageSource: { type: 'git', url: 'https://example.com/source' },
            versions,
          });
          return ok(parsed);
        },
      }),
  } as unknown as RegistryCore;
}

function buildConfig(): ConstructorParameters<typeof Installer>[0]['config'] {
  return {
    get: (key: string) => {
      if (key === 'network.maxConcurrentDownloads') return 2;
      if (key === 'network.retries') return 0;
      if (key === 'network.timeout') return 30;
      return undefined;
    },
  } as unknown as ConstructorParameters<typeof Installer>[0]['config'];
}

function buildLockfile(
  entries: Record<string, { version: string; sha256: string; dependencies?: Record<string, string> }>,
  registry = 'default',
): Lockfile {
  const packages: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(entries)) {
    packages[name] = {
      version: entry.version,
      registry,
      integrity: `sha256:${entry.sha256}`,
      gitTree: 'a'.repeat(40),
      ...(entry.dependencies ? { dependencies: entry.dependencies } : {}),
    };
  }
  return { lockfileVersion: 1, packages } as Lockfile;
}

async function writeRegistryMeta(
  shortId: string,
  registryType: 'public' | 'private',
  schemaVersion = 1,
  format: RegistryMetaFixtureFormat = 'reduced',
): Promise<void> {
  const profileRoot = await makeTempDir('uapkg-installer-profile-');
  process.env.UAPKG_INTERNAL_CONFIG_CACHE_HOME = profileRoot;
  const metaDir = join(profileRoot, 'registry', shortId, 'registry', '.uapkg');
  await mkdir(metaDir, { recursive: true });
  await writeFile(
    join(metaDir, 'registry.meta.json'),
    JSON.stringify(registryMetaFixture({ format, registryType, schemaVersion, name: 'Test registry' })),
    'utf8',
  );
}

async function runInstall(
  fixtures: Map<string, RegistryFixtureVersion>,
  lockfile: Lockfile,
  rootDependencies: readonly string[],
  shortId = 'testshortid',
) {
  const manifestRoot = await makeTempDir('uapkg-installer-root-');
  const installer = new Installer({
    registryCore: buildRegistryCore(fixtures, shortId),
    config: buildConfig(),
  });
  const result = await installer.execute(lockfile, null, { manifestRoot, rootDependencies });
  return { result, manifestRoot };
}

function fixtureKey(name: string, version: string): string {
  return `${name}@@${version}`;
}

describe('verification-gated partial installation', () => {
  it('preserves old directories during a partial install and cleans them on an unchanged-lock retry', async () => {
    const version = '1.0.0';
    const fixtures = new Map<string, RegistryFixtureVersion>();
    for (const name of ['old-plugin', 'healthy', 'recovering']) {
      fixtures.set(fixtureKey(name, version), {
        artifact: await makeArtifact(name, version, { name, kind: 'plugin', version }),
      });
    }
    const selected = (names: string[]) =>
      buildLockfile(
        Object.fromEntries(
          names.map((name) => [name, { version, sha256: fixtures.get(fixtureKey(name, version))!.artifact.sha256 }]),
        ),
      );
    const previous = selected(['old-plugin']);
    const replacement = selected(['healthy', 'recovering']);
    const workspace = await makeTempDir('uapkg-deferred-');
    const installer = new Installer({
      registryCore: buildRegistryCore(fixtures, 'testshortid'),
      config: buildConfig(),
    });
    await installer.execute(previous, null, { manifestRoot: workspace, rootDependencies: ['old-plugin'] });
    const old = await installer.getVerifiedRelease(previous, workspace, 'old-plugin');
    const endpoint = new URL(fixtures.get(fixtureKey('recovering', version))!.artifact.url).pathname;
    const bytes = artifacts.get(endpoint)!;
    artifacts.set(endpoint, Buffer.from('incomplete download'));
    const options = { manifestRoot: workspace, rootDependencies: ['healthy', 'recovering'] };
    const partial = await installer.execute(replacement, previous, options);
    expect(partial).toMatchObject({
      ok: true,
      value: { installed: ['healthy'], failed: ['recovering'], deferredRemovals: ['old-plugin'] },
    });
    expect(existsSync(old.installedPath)).toBe(true);
    artifacts.set(endpoint, bytes);
    const recovered = await installer.execute(replacement, replacement, options);
    expect(recovered).toMatchObject({
      ok: true,
      value: { installed: ['recovering'], failed: [], deferredRemovals: [] },
    });
    expect(existsSync(old.installedPath)).toBe(false);
    if (recovered.ok) expect(recovered.value.outcomes).toContainEqual({ packageName: 'old-plugin', status: 'removed' });
    const again = await installer.execute(replacement, replacement, options);
    expect(again).toMatchObject({ ok: true, value: { plan: { summary: { removed: 0 } } } });
  });

  it('retains the receipt after a failed removal and refuses to delete another directory at the same installed path', async () => {
    const name = 'mesh';
    const version = '1.0.0';
    const artifact = await makeArtifact(name, version, { name, version, kind: 'plugin' });
    const installer = new Installer({
      registryCore: buildRegistryCore(new Map([[fixtureKey(name, version), { artifact }]]), 'testshortid'),
      config: buildConfig(),
    });
    const locked = buildLockfile({ [name]: { version, sha256: artifact.sha256 } });
    const empty = buildLockfile({});
    const workspace = await makeTempDir('uapkg-owned-remove-');
    await installer.execute(locked, null, { manifestRoot: workspace, rootDependencies: [name] });
    const owned = await installer.getVerifiedRelease(locked, workspace, name);
    const original = join(workspace, 'original-directory');
    await rename(owned.installedPath, original);
    await mkdir(owned.installedPath);
    await writeFile(join(owned.installedPath, 'uapkg.json'), JSON.stringify({ name, version, kind: 'plugin' }));
    const options = { manifestRoot: workspace, rootDependencies: [] };
    expect(await installer.execute(empty, locked, options)).toMatchObject({ ok: true, value: { failed: [name] } });
    expect(await installer.execute(empty, empty, options)).toMatchObject({ ok: true, value: { failed: [name] } });
    expect(existsSync(join(owned.installedPath, 'uapkg.json'))).toBe(true);
    await rename(owned.installedPath, join(workspace, 'unmanaged-directory'));
    await rename(original, owned.installedPath);
    expect(await installer.execute(empty, empty, options)).toMatchObject({
      ok: true,
      value: { failed: [], outcomes: [{ packageName: name, status: 'removed' }] },
    });
    expect(existsSync(owned.installedPath)).toBe(false);
  });
  it('retains a verified release across unchanged installs and snapshots its archived bytes independently of local edits', async () => {
    const name = 'mesh';
    const artifact = await makeArtifact(name, '1.0.0', { kind: 'plugin', name, version: '1.0.0' });
    const fixtures = new Map([[fixtureKey(name, '1.0.0'), { artifact }]]);
    const lockfile = buildLockfile({ [name]: { version: '1.0.0', sha256: artifact.sha256 } });
    const workspace = await makeTempDir('uapkg-retry-');
    const options = { manifestRoot: workspace, rootDependencies: [name] };
    const installer = new Installer({
      registryCore: buildRegistryCore(fixtures, 'testshortid'),
      config: buildConfig(),
    });
    const installed = await installer.execute(lockfile, null, options);
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const original = await installer.getVerifiedRelease(lockfile, workspace, name);
    expect(original.activationId).toBe(installed.value.verifiedReleases[0].activationId);
    await writeFile(join(original.installedPath, 'payload.txt'), 'locally edited');
    artifacts.clear();
    const retried = await installer.execute(lockfile, lockfile, options);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.outcomes).toEqual([{ packageName: name, status: 'unchanged' }]);
    expect(retried.value.verifiedReleases).toEqual([original]);
    let temporaryPath = '';
    const contents = await installer.withVerifiedSnapshot(original, async (root) => {
      temporaryPath = root;
      return readFile(join(root, 'payload.txt'), 'utf8');
    });
    expect(contents).toBe('content of mesh@1.0.0');
    expect(existsSync(temporaryPath)).toBe(false);
    const redirected = new Installer({
      registryCore: buildRegistryCore(fixtures, 'other-registry'),
      config: buildConfig(),
    });
    await expect(redirected.getVerifiedRelease(lockfile, workspace, name)).rejects.toThrow('Run uapkg install');
    await writeFile(original.archivePath, 'replacement');
    await expect(installer.withVerifiedSnapshot(original, async () => true)).rejects.toThrow('archive changed');
    await expect(installer.getVerifiedRelease(lockfile, workspace, name)).rejects.toThrow('Run uapkg install');
  });

  it('starts a distinct lifecycle activation when the same verified release is removed and installed again', async () => {
    const name = 'mesh';
    const version = '1.0.0';
    const artifact = await makeArtifact(name, version, { kind: 'plugin', name, version });
    const fixtures = new Map([[fixtureKey(name, version), { artifact }]]);
    const installer = new Installer({
      registryCore: buildRegistryCore(fixtures, 'testshortid'),
      config: buildConfig(),
    });
    const lock = buildLockfile({ [name]: { version, sha256: artifact.sha256 } });
    const empty = buildLockfile({});
    const options = { manifestRoot: await makeTempDir('uapkg-reactivate-'), rootDependencies: [name] };
    expect((await installer.execute(lock, null, options)).ok).toBe(true);
    const before = await installer.getVerifiedRelease(lock, options.manifestRoot, name);
    expect((await installer.execute(empty, lock, { ...options, rootDependencies: [] })).ok).toBe(true);
    await expect(installer.getVerifiedRelease(lock, options.manifestRoot, name)).rejects.toThrow('Run uapkg install');
    expect((await installer.execute(lock, empty, options)).ok).toBe(true);
    const after = await installer.getVerifiedRelease(lock, options.manifestRoot, name);
    expect(after.activationId).not.toBe(before.activationId);
    expect({ ...after, activationId: before.activationId }).toEqual(before);
  });
  it('finishes a progress subscription attached before execution', async () => {
    const installer = new Installer({
      registryCore: buildRegistryCore(new Map(), 'testshortid'),
      config: buildConfig(),
    });
    const progress = installer.getStatusStream()[Symbol.asyncIterator]();
    const first = progress.next();
    const manifestRoot = await makeTempDir('uapkg-progress-');
    const result = await installer.execute(buildLockfile({}), null, { manifestRoot, dryRun: true });
    expect(result.ok).toBe(true);
    expect((await first).done).toBe(false);
    expect((await progress.next()).done).toBe(true);
  });

  it('finishes progress when the registry rejects the install plan', async () => {
    const fixture = await makeArtifact('mesh', '1.0.0', { name: 'mesh', version: '1.0.0', kind: 'plugin' });
    const registryCore = buildRegistryCore(
      new Map([[fixtureKey('mesh', '1.0.0'), { artifact: fixture }]]),
      'testshortid',
    );
    const installer = new Installer({ registryCore, config: buildConfig() });
    const manifestRoot = await makeTempDir('uapkg-progress-');
    const execution = installer.execute(buildLockfile({ mesh: { version: '2.0.0', sha256: fixture.sha256 } }), null, {
      manifestRoot,
    });
    const last = installer.getStatusStream()[Symbol.asyncIterator]().next();
    const result = await execution;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('INSTALL_VERSION_NOT_IN_REGISTRY');
    expect((await last).done).toBe(true);
  });

  it('installs a verified root and its verified dependency', async () => {
    const childArtifact = await makeArtifact('child-pkg', '1.0.0', {
      name: 'child-pkg',
      version: '1.0.0',
      kind: 'plugin',
    });
    const rootArtifact = await makeArtifact('root-pkg', '1.0.0', {
      name: 'root-pkg',
      version: '1.0.0',
      kind: 'plugin',
      dependencies: { 'child-pkg': '^1.0.0' },
    });
    const fixtures = new Map<string, RegistryFixtureVersion>([
      [fixtureKey('root-pkg', '1.0.0'), { artifact: rootArtifact, recordDependencies: { 'child-pkg': '^1.0.0' } }],
      [fixtureKey('child-pkg', '1.0.0'), { artifact: childArtifact }],
    ]);
    const lockfile = buildLockfile({
      'root-pkg': {
        version: '1.0.0',
        sha256: rootArtifact.sha256,
        dependencies: { 'child-pkg': '1.0.0' },
      },
      'child-pkg': { version: '1.0.0', sha256: childArtifact.sha256 },
    });

    const { result, manifestRoot } = await runInstall(fixtures, lockfile, ['root-pkg']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.installed].sort()).toEqual(['child-pkg', 'root-pkg']);
    expect(result.value.failed).toEqual([]);
    expect(result.value.skipped).toEqual([]);
    expect(result.value.incompleteClosure).toEqual([]);
    expect(existsSync(join(manifestRoot, 'Plugins', 'root-pkg', 'uapkg.json'))).toBe(true);
    expect(existsSync(join(manifestRoot, 'Plugins', 'child-pkg', 'uapkg.json'))).toBe(true);
  });

  it('installs a redirected archive only after size, digest, and packaged claims verify', async () => {
    const directArtifact = await makeArtifact('redirected-pkg', '1.0.0', {
      name: 'redirected-pkg',
      version: '1.0.0',
      kind: 'plugin',
    });
    const directPath = new URL(directArtifact.url).pathname;
    const redirectPath = '/releases/download/v1.0.0/redirected-pkg-1.0.0.tgz';
    redirects.set(redirectPath, directPath);
    const artifact = { ...directArtifact, url: `${baseUrl}${redirectPath}` };
    const fixtures = new Map<string, RegistryFixtureVersion>([[fixtureKey('redirected-pkg', '1.0.0'), { artifact }]]);
    const lockfile = buildLockfile({
      'redirected-pkg': { version: '1.0.0', sha256: artifact.sha256 },
    });

    const { result, manifestRoot } = await runInstall(fixtures, lockfile, ['redirected-pkg']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.installed).toEqual(['redirected-pkg']);
    expect(result.value.failed).toEqual([]);
    expect(await readFile(join(manifestRoot, 'Plugins', 'redirected-pkg', 'payload.txt'), 'utf8')).toBe(
      'content of redirected-pkg@1.0.0',
    );
  });

  it('rejects a package whose archive declares a dependency the registry omitted', async () => {
    const artifact = await makeArtifact('lying-pkg', '1.0.0', {
      name: 'lying-pkg',
      version: '1.0.0',
      kind: 'plugin',
      dependencies: { hidden: '^9.0.0' },
    });
    const fixtures = new Map<string, RegistryFixtureVersion>([[fixtureKey('lying-pkg', '1.0.0'), { artifact }]]);
    const lockfile = buildLockfile({ 'lying-pkg': { version: '1.0.0', sha256: artifact.sha256 } });

    const { result, manifestRoot } = await runInstall(fixtures, lockfile, ['lying-pkg']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failed).toEqual(['lying-pkg']);
    expect(result.value.installed).toEqual([]);
    expect(
      result.diagnostics.some((diagnostic) => (diagnostic.code as string) === 'INSTALL_MANIFEST_CLAIMS_MISMATCH'),
    ).toBe(true);
    expect(existsSync(join(manifestRoot, 'Plugins', 'lying-pkg'))).toBe(false);
  });

  it('never admits an edge injected by the registry when the archive lacks it', async () => {
    const injectedArtifact = await makeArtifact('injected-dep', '1.0.0', {
      name: 'injected-dep',
      version: '1.0.0',
      kind: 'plugin',
    });
    const parentArtifact = await makeArtifact('clean-parent', '1.0.0', {
      name: 'clean-parent',
      version: '1.0.0',
      kind: 'plugin',
    });
    const fixtures = new Map<string, RegistryFixtureVersion>([
      [
        fixtureKey('clean-parent', '1.0.0'),
        { artifact: parentArtifact, recordDependencies: { 'injected-dep': '^1.0.0' } },
      ],
      [fixtureKey('injected-dep', '1.0.0'), { artifact: injectedArtifact }],
    ]);
    const lockfile = buildLockfile({
      'clean-parent': {
        version: '1.0.0',
        sha256: parentArtifact.sha256,
        dependencies: { 'injected-dep': '1.0.0' },
      },
      'injected-dep': { version: '1.0.0', sha256: injectedArtifact.sha256 },
    });

    const { result, manifestRoot } = await runInstall(fixtures, lockfile, ['clean-parent']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Parent fails (registry claims an extra dependency), so the injected edge is never trusted.
    expect(result.value.failed).toEqual(['clean-parent']);
    expect(result.value.skipped).toEqual(['injected-dep']);
    expect(existsSync(join(manifestRoot, 'Plugins', 'injected-dep'))).toBe(false);
  });

  it('keeps a shared dependency eligible through its verified parent when another parent fails', async () => {
    const sharedArtifact = await makeArtifact('shared-dep', '1.0.0', {
      name: 'shared-dep',
      version: '1.0.0',
      kind: 'plugin',
    });
    const badParentArtifact = await makeArtifact('bad-parent', '1.0.0', {
      name: 'bad-parent',
      version: '1.0.0',
      kind: 'plugin',
      dependencies: { 'shared-dep': '^1.0.0', smuggled: '^1.0.0' },
    });
    const goodParentArtifact = await makeArtifact('good-parent', '1.0.0', {
      name: 'good-parent',
      version: '1.0.0',
      kind: 'plugin',
      dependencies: { 'shared-dep': '^1.0.0' },
    });
    const fixtures = new Map<string, RegistryFixtureVersion>([
      [
        fixtureKey('bad-parent', '1.0.0'),
        { artifact: badParentArtifact, recordDependencies: { 'shared-dep': '^1.0.0' } },
      ],
      [
        fixtureKey('good-parent', '1.0.0'),
        { artifact: goodParentArtifact, recordDependencies: { 'shared-dep': '^1.0.0' } },
      ],
      [fixtureKey('shared-dep', '1.0.0'), { artifact: sharedArtifact }],
    ]);
    const lockfile = buildLockfile({
      'bad-parent': {
        version: '1.0.0',
        sha256: badParentArtifact.sha256,
        dependencies: { 'shared-dep': '1.0.0' },
      },
      'good-parent': {
        version: '1.0.0',
        sha256: goodParentArtifact.sha256,
        dependencies: { 'shared-dep': '1.0.0' },
      },
      'shared-dep': { version: '1.0.0', sha256: sharedArtifact.sha256 },
    });

    const { result, manifestRoot } = await runInstall(fixtures, lockfile, ['bad-parent', 'good-parent']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failed).toEqual(['bad-parent']);
    expect([...result.value.installed].sort()).toEqual(['good-parent', 'shared-dep']);
    expect(existsSync(join(manifestRoot, 'Plugins', 'shared-dep', 'uapkg.json'))).toBe(true);
  });

  it('fails a package whose byte count differs from the registry size', async () => {
    const artifact = await makeArtifact('size-mismatch', '1.0.0', {
      name: 'size-mismatch',
      version: '1.0.0',
      kind: 'plugin',
    });
    const fixtures = new Map<string, RegistryFixtureVersion>([
      [fixtureKey('size-mismatch', '1.0.0'), { artifact: { ...artifact, size: artifact.size + 1 } }],
    ]);
    const lockfile = buildLockfile({
      'size-mismatch': { version: '1.0.0', sha256: artifact.sha256 },
    });

    const { result } = await runInstall(fixtures, lockfile, ['size-mismatch']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failed).toEqual(['size-mismatch']);
    expect(result.diagnostics.some((diagnostic) => (diagnostic.code as string) === 'INSTALL_SIZE_MISMATCH')).toBe(true);
  });

  it('fails a package whose bytes do not match the pinned hash', async () => {
    const artifact = await makeArtifact('hash-mismatch', '1.0.0', {
      name: 'hash-mismatch',
      version: '1.0.0',
      kind: 'plugin',
    });
    const fixtures = new Map<string, RegistryFixtureVersion>([[fixtureKey('hash-mismatch', '1.0.0'), { artifact }]]);
    // Lockfile pins a different digest than the served bytes.
    const lockfile = buildLockfile({
      'hash-mismatch': { version: '1.0.0', sha256: 'c'.repeat(64) },
    });

    const { result, manifestRoot } = await runInstall(fixtures, lockfile, ['hash-mismatch']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failed).toEqual(['hash-mismatch']);
    expect(existsSync(join(manifestRoot, 'Plugins', 'hash-mismatch'))).toBe(false);
  });

  it('treats a corrupt archive as a failure, never a silent success', async () => {
    const garbage = Buffer.from('this is definitely not a gzip archive');
    const artifact = serveRawArtifact('corrupt-pkg', '1.0.0', garbage);
    const fixtures = new Map<string, RegistryFixtureVersion>([[fixtureKey('corrupt-pkg', '1.0.0'), { artifact }]]);
    const lockfile = buildLockfile({
      'corrupt-pkg': { version: '1.0.0', sha256: artifact.sha256 },
    });

    const { result } = await runInstall(fixtures, lockfile, ['corrupt-pkg']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failed).toEqual(['corrupt-pkg']);
    expect(result.value.installed).toEqual([]);
  });

  it.each(['reduced', 'rich'] as const)(
    'rejects private: true from a public registry with %s metadata even when the record agrees',
    async (format) => {
      const shortId = 'publicshort';
      await writeRegistryMeta(shortId, 'public', 1, format);
      const artifact = await makeArtifact('private-pkg', '1.0.0', {
        name: 'private-pkg',
        version: '1.0.0',
        kind: 'plugin',
        private: true,
      });
      const fixtures = new Map<string, RegistryFixtureVersion>([
        [fixtureKey('private-pkg', '1.0.0'), { artifact, recordPrivate: true }],
      ]);
      const lockfile = buildLockfile({
        'private-pkg': { version: '1.0.0', sha256: artifact.sha256 },
      });

      const { result } = await runInstall(fixtures, lockfile, ['private-pkg'], shortId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.failed).toEqual(['private-pkg']);
      expect(
        result.diagnostics.some(
          (diagnostic) => (diagnostic.code as string) === 'INSTALL_PRIVATE_PACKAGE_IN_PUBLIC_REGISTRY',
        ),
      ).toBe(true);
    },
  );

  it.each(['reduced', 'rich'] as const)(
    'allows private: true without gitTree from a private registry with %s metadata when the record agrees',
    async (format) => {
      const shortId = 'privateshort';
      await writeRegistryMeta(shortId, 'private', 1, format);
      const artifact = await makeArtifact('private-ok', '1.0.0', {
        name: 'private-ok',
        version: '1.0.0',
        kind: 'plugin',
        private: true,
      });
      const fixtures = new Map<string, RegistryFixtureVersion>([
        [fixtureKey('private-ok', '1.0.0'), { artifact, recordPrivate: true, omitGitTree: true }],
      ]);
      const lockfile = buildLockfile({ 'private-ok': { version: '1.0.0', sha256: artifact.sha256 } });

      const { result } = await runInstall(fixtures, lockfile, ['private-ok'], shortId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.installed).toEqual(['private-ok']);
    },
  );

  it.each(['reduced', 'rich'] as const)(
    'rejects a public registry version that omits gitTree with %s metadata',
    async (format) => {
      const shortId = 'publicnotree';
      await writeRegistryMeta(shortId, 'public', 1, format);
      const artifact = await makeArtifact('no-tree', '1.0.0', {
        name: 'no-tree',
        version: '1.0.0',
        kind: 'plugin',
      });
      const fixtures = new Map<string, RegistryFixtureVersion>([
        [fixtureKey('no-tree', '1.0.0'), { artifact, omitGitTree: true }],
      ]);
      const lockfile = buildLockfile({ 'no-tree': { version: '1.0.0', sha256: artifact.sha256 } });

      const { result } = await runInstall(fixtures, lockfile, ['no-tree'], shortId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some(
          (diagnostic) => (diagnostic.code as string) === 'INSTALL_PUBLIC_REGISTRY_GITTREE_REQUIRED',
        ),
      ).toBe(true);
    },
  );

  it('fails closed when the registry metadata file is absent', async () => {
    const shortId = 'missingmeta';
    const artifact = await makeArtifact('missing-meta-pkg', '1.0.0', {
      name: 'missing-meta-pkg',
      version: '1.0.0',
      kind: 'plugin',
    });
    const fixtures = new Map<string, RegistryFixtureVersion>([[fixtureKey('missing-meta-pkg', '1.0.0'), { artifact }]]);
    const lockfile = buildLockfile({ 'missing-meta-pkg': { version: '1.0.0', sha256: artifact.sha256 } }, 'studio');

    const { result } = await runInstall(fixtures, lockfile, ['missing-meta-pkg'], shortId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const diagnostic = result.diagnostics.find((item) => (item.code as string) === 'INSTALL_REGISTRY_META_INVALID');
    expect(diagnostic?.message).toContain('registry "studio"');
    expect(diagnostic?.message).not.toContain(shortId);
  });

  it.each(['reduced', 'rich'] as const)(
    'fails closed when %s registry metadata uses an unknown schema version',
    async (format) => {
      const shortId = 'futuremeta';
      await writeRegistryMeta(shortId, 'private', 2, format);
      const artifact = await makeArtifact('future-meta-pkg', '1.0.0', {
        name: 'future-meta-pkg',
        version: '1.0.0',
        kind: 'plugin',
      });
      const fixtures = new Map<string, RegistryFixtureVersion>([
        [fixtureKey('future-meta-pkg', '1.0.0'), { artifact }],
      ]);
      const lockfile = buildLockfile({
        'future-meta-pkg': { version: '1.0.0', sha256: artifact.sha256 },
      });

      const { result } = await runInstall(fixtures, lockfile, ['future-meta-pkg'], shortId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some((diagnostic) => (diagnostic.code as string) === 'INSTALL_REGISTRY_META_INVALID'),
      ).toBe(true);
    },
  );

  it('reports an incomplete closure through every ancestor of a failed child', async () => {
    const brokenChildBytes = Buffer.from('broken child bytes');
    const childArtifact = serveRawArtifact('broken-child', '1.0.0', brokenChildBytes);
    const parentArtifact = await makeArtifact('sturdy-parent', '1.0.0', {
      name: 'sturdy-parent',
      version: '1.0.0',
      kind: 'plugin',
      dependencies: { 'broken-child': '^1.0.0' },
    });
    const rootArtifact = await makeArtifact('sturdy-root', '1.0.0', {
      name: 'sturdy-root',
      version: '1.0.0',
      kind: 'plugin',
      dependencies: { 'sturdy-parent': '^1.0.0' },
    });
    const fixtures = new Map<string, RegistryFixtureVersion>([
      [
        fixtureKey('sturdy-root', '1.0.0'),
        { artifact: rootArtifact, recordDependencies: { 'sturdy-parent': '^1.0.0' } },
      ],
      [
        fixtureKey('sturdy-parent', '1.0.0'),
        { artifact: parentArtifact, recordDependencies: { 'broken-child': '^1.0.0' } },
      ],
      [fixtureKey('broken-child', '1.0.0'), { artifact: childArtifact }],
    ]);
    const lockfile = buildLockfile({
      'sturdy-root': { version: '1.0.0', sha256: rootArtifact.sha256, dependencies: { 'sturdy-parent': '1.0.0' } },
      'sturdy-parent': {
        version: '1.0.0',
        sha256: parentArtifact.sha256,
        dependencies: { 'broken-child': '1.0.0' },
      },
      'broken-child': { version: '1.0.0', sha256: childArtifact.sha256 },
    });

    const { result } = await runInstall(fixtures, lockfile, ['sturdy-root']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.installed].sort()).toEqual(['sturdy-parent', 'sturdy-root']);
    expect(result.value.failed).toEqual(['broken-child']);
    expect([...result.value.incompleteClosure].sort()).toEqual(['sturdy-parent', 'sturdy-root']);
  });
});
