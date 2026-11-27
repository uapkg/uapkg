import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '@uapkg/diagnostics';
import { ManifestSchema, type Manifest } from '@uapkg/package-manifest-schema';
import { getRegistryRepoPath } from '@uapkg/registry-core';
import { c as createTar } from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CompositionRoot } from '../../src/app/CompositionRoot.ts';
import { PublishCommand, readTrustedRegistryType } from '../../src/commands/PublishCommand.ts';
import { AuthenticationSelector } from '../../src/control-plane/AuthenticationSelector.ts';
import { ControlPlaneClient } from '../../src/control-plane/ControlPlaneClient.ts';
import { ControlPlaneError, type RegistryTrust } from '../../src/control-plane/ControlPlaneTypes.ts';
import { createGitHubActionsPublishIdempotencyKey } from '../../src/control-plane/PublishIdempotencyStore.ts';
import {
  registryMetaFixture,
  type RegistryMetaFixtureFormat,
} from '../../../uapkg-registry-schema/tests/fixtures/registryMetaFixture.ts';

const cleanups: string[] = [];
let profileHome: string;

beforeEach(async () => {
  profileHome = await mkdtemp(join(tmpdir(), 'uapkg-publish-profile-'));
  cleanups.push(profileHome);
  vi.stubEnv('UAPKG_INTERNAL_CONFIG_CACHE_HOME', profileHome);
  await writeTrustedRegistryMeta('registry-cache', 'private');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeArchive(manifest: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'uapkg-publish-archive-'));
  cleanups.push(dir);
  const contentRoot = join(dir, 'pack-root');
  await mkdir(contentRoot, { recursive: true });
  await writeFile(join(contentRoot, 'uapkg.json'), JSON.stringify(manifest), 'utf8');
  const archivePath = join(dir, 'package.tgz');
  await createTar({ gzip: true, file: archivePath, cwd: dir, portable: true }, ['pack-root']);
  return archivePath;
}

async function writeTrustedRegistryMeta(
  shortId: string,
  registryType: 'public' | 'private',
  schemaVersion = 1,
  format: RegistryMetaFixtureFormat = 'reduced',
): Promise<void> {
  const metaDir = join(getRegistryRepoPath(shortId), '.uapkg');
  await mkdir(metaDir, { recursive: true });
  await writeFile(
    join(metaDir, 'registry.meta.json'),
    JSON.stringify(registryMetaFixture({ format, registryType, schemaVersion })),
    'utf8',
  );
}

describe.each(['reduced', 'rich'] as const)('trusted registry metadata for publishing (%s)', (format) => {
  it('rejects both an absent metadata file and an unsupported present version', async () => {
    await expect(readTrustedRegistryType('missing-meta')).rejects.toThrow('metadata is missing');

    await writeTrustedRegistryMeta('future-meta', 'private', 2, format);
    await expect(readTrustedRegistryType('future-meta')).rejects.toThrow('unsupported schema version');
  });

  it.each(['public', 'private'] as const)(
    'reads the %s type through the shared metadata schema',
    async (registryType) => {
      await writeTrustedRegistryMeta('valid-meta', registryType, 1, format);

      await expect(readTrustedRegistryType('valid-meta')).resolves.toBe(registryType);
    },
  );

  it.each(['public', 'private'] as const)(
    'preserves the %s registry policy for private packages',
    async (registryType) => {
      const trust = registryTrust();
      await writeTrustedRegistryMeta(trust.cacheShortId, registryType, 1, format);
      const archivePath = await makeArchive({ name: 'example', version: '1.2.3', kind: 'plugin', private: true });
      const select = vi.spyOn(AuthenticationSelector.prototype, 'select').mockResolvedValue({
        kind: 'login',
        credential: { kind: 'bearer', accessToken: 'memory-only-token' },
      });
      const submit = vi.spyOn(ControlPlaneClient.prototype, 'submitRegistryRequest').mockResolvedValue({
        requestId: 'request-private-policy',
        status: 'queued',
        message: 'queued',
      });
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const command = new PublishCommand(publishRoot(trust), {
        repository: 'acme/example',
        tag: 'v1.2.3',
        asset: 'package.tgz',
        assetPath: archivePath,
        auth: 'login',
        detach: true,
        outputFormat: 'text',
      });

      await expect(command.execute()).resolves.toBe(registryType === 'public' ? 1 : 0);
      if (registryType === 'public') {
        expect(stderr.mock.calls.map(([value]) => String(value)).join('')).toContain(
          'does not accept private packages',
        );
        expect(select).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
      } else {
        expect(submit).toHaveBeenCalledWith(
          expect.anything(),
          'publish',
          expect.objectContaining({
            payload: expect.objectContaining({ claims: expect.objectContaining({ private: true }) }),
          }),
          expect.anything(),
        );
      }
    },
  );
});

describe('PublishCommand (artifact-first)', () => {
  it('resolves default registry trust for a private artifact before applying registry policy', async () => {
    const archivePath = await makeArchive({ name: 'private-package', version: '1.0.0', kind: 'plugin', private: true });
    const resolveTrust = vi.fn(async () => {
      throw new Error('trusted registry policy reached');
    });
    const root = {
      cwd: process.cwd(),
      packageManifest: {
        readManifest: vi.fn(async () =>
          ok({
            name: 'private-package',
            version: '1.0.0',
            kind: 'plugin',
            private: true,
          } as Manifest),
        ),
      },
      registryTrustResolver: { resolve: resolveTrust },
    } as unknown as CompositionRoot;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const command = new PublishCommand(root, {
      assetPath: archivePath,
      repository: 'acme/private-package',
      auth: 'login',
      detach: true,
      outputFormat: 'text',
    });

    await expect(command.execute()).resolves.toBe(1);

    expect(resolveTrust).toHaveBeenCalledWith('default');
    const output = stderr.mock.calls.map(([value]) => String(value)).join('');
    expect(output).toContain('trusted registry policy reached');
  });

  it.each([
    { name: 'archived-plugin', publish: { registry: 'studio' } },
    { name: 'local-plugin', dependencies: { 'archived-plugin': { version: '1.0.0', registry: 'studio' } } },
  ])('requires an explicit registry for the archive package when the local manifest is $name', async (declaration) => {
    const archivePath = await makeArchive({ name: 'archived-plugin', version: '1.0.0', kind: 'plugin' });
    const root = publishRoot(registryTrust());
    const resolveTrust = vi.spyOn(root.registryTrustResolver, 'resolve');
    vi.spyOn(root.packageManifest, 'readManifest').mockResolvedValue(
      ok(
        ManifestSchema.parse({
          kind: 'plugin',
          version: '1.0.0',
          ...declaration,
        }),
      ),
    );
    const lookup = vi.fn(async () => ok({ name: 'archived-plugin' }));
    Object.assign(root, { registryCore: { getOrCreateRegistry: () => ok({ getPackageManifest: lookup }) } });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const select = vi
      .spyOn(AuthenticationSelector.prototype, 'select')
      .mockRejectedValue(new Error('unexpected credential request'));
    const submit = vi
      .spyOn(ControlPlaneClient.prototype, 'submitRegistryRequest')
      .mockRejectedValue(new Error('unexpected submission'));

    const command = new PublishCommand(root, {
      assetPath: archivePath,
      repository: 'acme/plugin',
      auth: 'login',
      detach: true,
      outputFormat: 'json',
    });
    expect(await command.execute()).toBe(1);
    expect(lookup).toHaveBeenCalledWith('archived-plugin', 'default');
    const error = stderr.mock.calls.map(([line]) => String(line)).join('');
    expect(error).toContain('archived-plugin');
    expect(error).toContain('--registry');
    expect(error).toContain('studio');
    expect(resolveTrust).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('requests only create capability for a detached publication', async () => {
    const trust = registryTrust();
    const archivePath = await makeArchive({ name: 'example', version: '1.2.3', kind: 'plugin' });
    const select = vi.spyOn(AuthenticationSelector.prototype, 'select').mockResolvedValue({
      kind: 'login',
      credential: { kind: 'bearer', accessToken: 'memory-only-token' },
      otp: '123456',
    });
    vi.spyOn(ControlPlaneClient.prototype, 'submitRegistryRequest').mockResolvedValue({
      requestId: 'request-detached',
      status: 'queued',
      message: 'queued',
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const root = publishRoot(trust);
    const command = new PublishCommand(root, {
      repository: 'acme/example',
      tag: 'v1.2.3',
      asset: 'package.tgz',
      assetPath: archivePath,
      auth: 'login',
      detach: true,
      outputFormat: 'json',
    });

    await expect(command.execute()).resolves.toBe(0);

    expect(select).toHaveBeenCalledWith('login', trust, ['publishing.request.create'], true, {
      registryId: trust.registryId,
      packageName: 'example',
    });
  });

  it('submits archive-derived claims and observed integrity to the dedicated publish route', async () => {
    const trust = registryTrust();
    const manifest = {
      name: 'example',
      version: '1.2.3',
      kind: 'plugin',
      dependencies: { 'core-utils': '^1.0.0' },
    };
    const archivePath = await makeArchive(manifest);
    const archiveBytes = await readFile(archivePath);
    const expectedDigest = `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`;

    const forceRefresh = vi.fn(async () => undefined);
    const select = vi.spyOn(AuthenticationSelector.prototype, 'select').mockResolvedValue({
      kind: 'login',
      credential: { kind: 'bearer', accessToken: 'memory-only-token' },
      otp: '123456',
    });
    const submit = vi.spyOn(ControlPlaneClient.prototype, 'submitRegistryRequest').mockResolvedValue({
      requestId: 'request-ready',
      status: 'queued',
      message: 'queued',
    });
    vi.spyOn(ControlPlaneClient.prototype, 'getRegistryRequestDetail').mockResolvedValue({
      request: {
        id: 'request-ready',
        registryId: trust.registryId,
        kind: 'publish',
        status: 'ready',
      },
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const root = publishRoot(trust, {
      registry: 'manifest-registry',
      owner: 'manifest-owner',
      repository: 'manifest/repository',
      asset: 'manifest.tgz',
    });
    const resolveTrust = vi.spyOn(root.registryTrustResolver, 'resolve');
    Object.assign(root.registryTrustResolver, { forceRefresh });
    const command = new PublishCommand(root, {
      registry: 'cli-registry',
      owner: 'cli-owner',
      repository: 'cli/repository',
      tag: 'release-1.2.3',
      asset: 'cli.tgz',
      assetPath: archivePath,
      auth: 'login',
      detach: false,
      outputFormat: 'json',
    });

    await expect(command.execute()).resolves.toBe(0);

    expect(resolveTrust).toHaveBeenCalledWith('cli-registry');
    expect(select).toHaveBeenCalledWith(
      'login',
      trust,
      ['publishing.request.create', 'publishing.request.read.self'],
      true,
      { registryId: trust.registryId, packageName: 'example' },
    );
    expect(submit).toHaveBeenCalledWith(
      expect.anything(),
      'publish',
      {
        registryId: trust.registryId,
        ownerOrganizationName: 'cli-owner',
        payload: {
          packageName: 'example',
          packageVersion: '1.2.3',
          source: {
            type: 'github_release',
            repository: 'cli/repository',
            releaseTag: 'release-1.2.3',
            assetName: 'cli.tgz',
          },
          observedIntegrity: { sha256: expectedDigest, sizeBytes: archiveBytes.length },
          claims: {
            name: 'example',
            version: '1.2.3',
            private: false,
            dependencies: { 'core-utils': { version: '^1.0.0' } },
            devDependencies: {},
            peerDependencies: {},
          },
        },
      },
      { idempotencyKey: expect.any(String), otp: '123456' },
    );
    expect(forceRefresh).toHaveBeenCalledWith(trust);
  });

  it('watches a queued publish through rejection and returns the failed check', async () => {
    const trust = registryTrust();
    const archivePath = await makeArchive({ name: 'example', version: '1.2.3', kind: 'plugin' });
    vi.spyOn(AuthenticationSelector.prototype, 'select').mockResolvedValue({
      kind: 'login',
      credential: { kind: 'bearer', accessToken: 'memory-only-token' },
    });
    vi.spyOn(ControlPlaneClient.prototype, 'submitRegistryRequest').mockResolvedValue({
      requestId: 'request-rejected',
      status: 'queued',
      message: 'queued',
    });
    vi.spyOn(ControlPlaneClient.prototype, 'getRegistryRequestDetail')
      .mockResolvedValueOnce({
        request: {
          id: 'request-rejected',
          registryId: trust.registryId,
          kind: 'publish',
          status: 'checking',
        },
      })
      .mockResolvedValueOnce({
        request: {
          id: 'request-rejected',
          registryId: trust.registryId,
          kind: 'publish',
          status: 'rejected',
        },
        checks: [
          {
            checkId: 'publish.source-revalidation',
            executionState: 'completed',
            conclusion: 'failure',
            reasonCode: 'GITHUB_RELEASE_NOT_FOUND',
          },
        ],
      });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const execution = new PublishCommand(publishRoot(trust), {
      repository: 'acme/example',
      tag: 'v1.2.3',
      asset: 'package.tgz',
      assetPath: archivePath,
      auth: 'login',
      detach: false,
      outputFormat: 'json',
    }).execute();

    await expect(execution).resolves.toBe(1);
    expect(stdout).toHaveBeenCalledWith(
      `${JSON.stringify({
        ok: false,
        registry: trust.alias,
        request: {
          id: 'request-rejected',
          registryId: trust.registryId,
          kind: 'publish',
          status: 'rejected',
        },
        checks: [
          {
            checkId: 'publish.source-revalidation',
            executionState: 'completed',
            conclusion: 'failure',
            reasonCode: 'GITHUB_RELEASE_NOT_FOUND',
          },
        ],
      })}\n`,
    );
  });

  it('reuses the persisted idempotency key for a retried identical submission', async () => {
    const trust = registryTrust();
    const archivePath = await makeArchive({ name: 'example', version: '1.2.3', kind: 'plugin' });
    vi.spyOn(AuthenticationSelector.prototype, 'select').mockResolvedValue({
      kind: 'login',
      credential: { kind: 'bearer', accessToken: 'memory-only-token' },
      otp: undefined,
    });
    const submit = vi.spyOn(ControlPlaneClient.prototype, 'submitRegistryRequest').mockResolvedValue({
      requestId: 'request-detached',
      status: 'queued',
      message: 'queued',
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const options = {
      repository: 'acme/example',
      tag: 'v1.2.3',
      asset: 'package.tgz',
      assetPath: archivePath,
      auth: 'login' as const,
      detach: true,
      outputFormat: 'json' as const,
    };
    await expect(new PublishCommand(publishRoot(trust), options).execute()).resolves.toBe(0);
    await expect(new PublishCommand(publishRoot(trust), options).execute()).resolves.toBe(0);

    const firstOptions = submit.mock.calls[0]?.[3] as { idempotencyKey?: string } | undefined;
    const secondOptions = submit.mock.calls[1]?.[3] as { idempotencyKey?: string } | undefined;
    const firstKey = firstOptions?.idempotencyKey;
    const secondKey = secondOptions?.idempotencyKey;
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
  });

  it('derives a deterministic Actions idempotency key that excludes the run attempt', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_RUN_ID', '987654321');
    vi.stubEnv('GITHUB_JOB', 'publish');
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '1');
    const trust = registryTrust();
    const archivePath = await makeArchive({ name: 'example', version: '1.2.3', kind: 'plugin' });
    const archiveBytes = await readFile(archivePath);
    const artifactSha256 = `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`;
    vi.spyOn(AuthenticationSelector.prototype, 'select').mockResolvedValue({
      kind: 'oidc',
      credential: { kind: 'bearer', accessToken: 'oidc-session' },
    });
    const submit = vi.spyOn(ControlPlaneClient.prototype, 'submitRegistryRequest').mockResolvedValue({
      requestId: 'request-detached',
      status: 'queued',
      message: 'queued',
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const options = {
      repository: 'acme/example',
      tag: 'v1.2.3',
      asset: 'package.tgz',
      assetPath: archivePath,
      auth: 'oidc' as const,
      detach: true,
      outputFormat: 'json' as const,
    };

    await expect(new PublishCommand(publishRoot(trust), options).execute()).resolves.toBe(0);
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '2');
    await expect(new PublishCommand(publishRoot(trust), options).execute()).resolves.toBe(0);

    const expected = createGitHubActionsPublishIdempotencyKey(
      {
        registryId: trust.registryId,
        packageName: 'example',
        packageVersion: '1.2.3',
        artifactSha256,
      },
      {
        GITHUB_RUN_ID: '987654321',
        GITHUB_JOB: 'publish',
        GITHUB_RUN_ATTEMPT: '999',
      },
    );
    const firstOptions = submit.mock.calls[0]?.[3] as { idempotencyKey?: string } | undefined;
    const rerunOptions = submit.mock.calls[1]?.[3] as { idempotencyKey?: string } | undefined;
    const firstKey = firstOptions?.idempotencyKey;
    const rerunKey = rerunOptions?.idempotencyKey;
    expect(firstKey).toBe(expected);
    expect(firstKey).toMatch(/^gha-[0-9a-f]{64}$/);
    expect(rerunKey).toBe(firstKey);
    expect(
      createGitHubActionsPublishIdempotencyKey(
        {
          registryId: trust.registryId,
          packageName: 'example',
          packageVersion: '1.2.3',
          artifactSha256: `sha256:${'f'.repeat(64)}`,
        },
        { GITHUB_RUN_ID: '987654321', GITHUB_JOB: 'publish' },
      ),
    ).not.toBe(firstKey);
  });

  it('reports a typed diagnostic when synchronous submission fails in text mode', async () => {
    const trust = registryTrust();
    const archivePath = await makeArchive({ name: 'example', version: '1.2.3', kind: 'plugin' });
    vi.spyOn(AuthenticationSelector.prototype, 'select').mockResolvedValue({
      kind: 'login',
      credential: { kind: 'bearer', accessToken: 'memory-only-token' },
    });
    vi.spyOn(ControlPlaneClient.prototype, 'submitRegistryRequest').mockRejectedValue(
      new ControlPlaneError(
        'UNSCOPED_PACKAGE_OWNER_REQUIRED',
        'Initial publication requires ownerOrganizationName.',
        400,
        { packageName: 'example' },
      ),
    );
    const reportOne = vi.fn();
    const root = publishRoot(trust);
    Object.assign(root, { diagnostics: { reportOne } });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      new PublishCommand(root, {
        repository: 'acme/example',
        assetPath: archivePath,
        auth: 'login',
        detach: true,
        outputFormat: 'text',
      }).execute(),
    ).resolves.toBe(1);

    expect(reportOne).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'PUBLISH_REQUEST_FAILED',
        message: expect.stringContaining('needs an owner organization'),
        data: expect.objectContaining({
          serverCode: 'UNSCOPED_PACKAGE_OWNER_REQUIRED',
          status: 400,
        }),
      }),
    );
    expect(stderr).not.toHaveBeenCalled();
  });

  it('preserves the existing JSON-mode submission failure path', async () => {
    const trust = registryTrust();
    const archivePath = await makeArchive({ name: 'example', version: '1.2.3', kind: 'plugin' });
    vi.spyOn(AuthenticationSelector.prototype, 'select').mockResolvedValue({
      kind: 'login',
      credential: { kind: 'bearer', accessToken: 'memory-only-token' },
    });
    vi.spyOn(ControlPlaneClient.prototype, 'submitRegistryRequest').mockRejectedValue(
      new ControlPlaneError('UNSCOPED_PACKAGE_OWNER_REQUIRED', 'Existing JSON failure output.', 400),
    );
    const reportOne = vi.fn();
    const root = publishRoot(trust);
    Object.assign(root, { diagnostics: { reportOne } });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      new PublishCommand(root, {
        repository: 'acme/example',
        assetPath: archivePath,
        auth: 'login',
        detach: true,
        outputFormat: 'json',
      }).execute(),
    ).resolves.toBe(1);

    expect(reportOne).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map(([value]) => String(value)).join('')).toBe(
      'Existing JSON failure output. (UNSCOPED_PACKAGE_OWNER_REQUIRED)\n',
    );
  });

  it('leaves permanent status-polling failures on the existing outer error path', async () => {
    const trust = registryTrust();
    const archivePath = await makeArchive({ name: 'example', version: '1.2.3', kind: 'plugin' });
    vi.spyOn(AuthenticationSelector.prototype, 'select').mockResolvedValue({
      kind: 'login',
      credential: { kind: 'bearer', accessToken: 'memory-only-token' },
    });
    vi.spyOn(ControlPlaneClient.prototype, 'submitRegistryRequest').mockResolvedValue({
      requestId: 'request-polling',
      status: 'queued',
      message: 'queued',
    });
    vi.spyOn(ControlPlaneClient.prototype, 'getRegistryRequestDetail').mockRejectedValue(
      new ControlPlaneError('REQUEST_STATUS_FORBIDDEN', 'Status polling failed.', 403),
    );
    const reportOne = vi.fn();
    const root = publishRoot(trust);
    Object.assign(root, { diagnostics: { reportOne } });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      new PublishCommand(root, {
        repository: 'acme/example',
        assetPath: archivePath,
        auth: 'login',
        detach: false,
        outputFormat: 'text',
      }).execute(),
    ).resolves.toBe(1);

    expect(reportOne).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map(([value]) => String(value)).join('')).toBe(
      'Status polling failed. (REQUEST_STATUS_FORBIDDEN)\n',
    );
  });

  it('backs off a throttled status read without submitting the publication twice', async () => {
    const trust = registryTrust();
    const archivePath = await makeArchive({ name: 'example', version: '1.2.3', kind: 'plugin' });
    vi.useFakeTimers();
    vi.spyOn(AuthenticationSelector.prototype, 'select').mockResolvedValue({
      kind: 'login',
      credential: { kind: 'bearer', accessToken: 'test-token' },
    });
    const submit = vi
      .spyOn(ControlPlaneClient.prototype, 'submitRegistryRequest')
      .mockResolvedValue({ requestId: 'request-ready', status: 'queued', message: 'queued' });
    let started!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      started = resolve;
    });
    const read = vi
      .spyOn(ControlPlaneClient.prototype, 'getRegistryRequestDetail')
      .mockImplementationOnce(async () => {
        started();
        throw new ControlPlaneError('RATE_LIMIT_EXCEEDED', 'Wait', 429, undefined, { retryAfterMs: 60_000 });
      })
      .mockResolvedValueOnce({
        request: { id: 'request-ready', registryId: trust.registryId, kind: 'publish', status: 'ready' },
      });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const result = new PublishCommand(publishRoot(trust), {
      repository: 'acme/example',
      assetPath: archivePath,
      auth: 'login',
      detach: false,
      outputFormat: 'json',
    }).execute();
    await firstRead;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(0);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('re-exchanges an expired OIDC session while reading request status', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_RUN_ID', '12345');
    vi.stubEnv('GITHUB_JOB', 'publish');
    const trust = registryTrust();
    const archivePath = await makeArchive({ name: 'example', version: '1.2.3', kind: 'plugin' });
    const select = vi
      .spyOn(AuthenticationSelector.prototype, 'select')
      .mockResolvedValueOnce({
        kind: 'oidc',
        credential: { kind: 'bearer', accessToken: 'oidc-session-one' },
      })
      .mockResolvedValueOnce({
        kind: 'oidc',
        credential: { kind: 'bearer', accessToken: 'oidc-session-two' },
      });
    vi.spyOn(ControlPlaneClient.prototype, 'submitRegistryRequest').mockResolvedValue({
      requestId: 'request-ready',
      status: 'queued',
      message: 'queued',
    });
    const getRequest = vi
      .spyOn(ControlPlaneClient.prototype, 'getRegistryRequestDetail')
      .mockRejectedValueOnce(new ControlPlaneError('OIDC_SESSION_EXPIRED', 'Session expired.', 401))
      .mockResolvedValueOnce({
        request: {
          id: 'request-ready',
          registryId: trust.registryId,
          kind: 'publish',
          status: 'ready',
        },
      });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(
      new PublishCommand(publishRoot(trust), {
        repository: 'acme/example',
        tag: 'v1.2.3',
        asset: 'package.tgz',
        assetPath: archivePath,
        auth: 'oidc',
        detach: false,
        outputFormat: 'json',
      }).execute(),
    ).resolves.toBe(0);

    expect(select).toHaveBeenNthCalledWith(
      1,
      'oidc',
      trust,
      ['publishing.request.create', 'publishing.request.read.self'],
      true,
      { registryId: trust.registryId, packageName: 'example' },
    );
    expect(select).toHaveBeenNthCalledWith(2, 'oidc', trust, ['publishing.request.read.self'], false, {
      registryId: trust.registryId,
      packageName: 'example',
    });
    expect(getRequest).toHaveBeenNthCalledWith(
      1,
      { kind: 'bearer', accessToken: 'oidc-session-one' },
      'request-ready',
      expect.any(AbortSignal),
    );
    expect(getRequest).toHaveBeenNthCalledWith(
      2,
      { kind: 'bearer', accessToken: 'oidc-session-two' },
      'request-ready',
      expect.any(AbortSignal),
    );
  });
});

function registryTrust(): RegistryTrust {
  const registryId = '00000000-0000-4000-a000-000000000020';
  return {
    alias: 'official',
    registryId,
    registryName: 'Official',
    repositoryUrl: 'https://github.com/uapkg/registry.git',
    repositoryFingerprint: `sha256:${'a'.repeat(64)}`,
    issuer: 'https://account.uapkg.dev/oauth',
    apiBaseUrl: 'https://api.uapkg.dev',
    resource: `https://api.uapkg.dev/v1/registries/${registryId}`,
    cacheShortId: 'registry-cache',
  };
}

function publishRoot(
  trust: RegistryTrust,
  publish?: {
    registry?: string;
    owner?: string;
    repository?: string;
    asset?: string;
  },
): CompositionRoot {
  return {
    cwd: process.cwd(),
    packageManifest: {
      readManifest: vi.fn(async () =>
        ok({
          name: 'example',
          version: '1.2.3',
          kind: 'plugin',
          publish,
        } as Manifest),
      ),
    },
    registryTrustResolver: {
      resolve: vi.fn(async () => trust),
      forceRefresh: vi.fn(async () => undefined),
    },
    accountManager: {},
  } as unknown as CompositionRoot;
}
