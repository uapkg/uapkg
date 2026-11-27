import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { CompositionRoot } from '../../src/app/CompositionRoot.ts';
import { registryMetaFixture } from '../../../uapkg-registry-schema/tests/fixtures/registryMetaFixture.ts';
import {
  canonicalizeRegistryGitOrigin,
  fingerprintRegistryGitOrigin,
  RegistryTrustResolver,
} from '../../src/control-plane/RegistryTrustResolver.ts';

const readFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
}));

describe('registry control-plane source identity', () => {
  it.each([
    'https://github.com/UAPKG/Registry.git',
    'ssh://git@github.com/UAPKG/Registry.git',
    'git@github.com:UAPKG/Registry.git',
  ])('canonicalizes equivalent GitHub origin %s', (origin) => {
    expect(canonicalizeRegistryGitOrigin(origin)).toBe('https://github.com/uapkg/registry.git');
  });

  it('uses the server contract sha256:<64 lowercase hex> fingerprint', () => {
    const canonical = 'https://github.com/uapkg/registry.git';
    const expected = createHash('sha256').update(canonical).digest('hex');

    expect(fingerprintRegistryGitOrigin('git@github.com:UAPKG/Registry.git')).toBe(`sha256:${expected}`);
  });

  it.each([
    ['reduced', {}],
    ['rich', {}],
    ['rich', { identifier: 'legacy-service-generated-value' }],
  ] as const)('resolves %s metadata using the UUID, display name, and Git origin', async (format, legacyFields) => {
    const meta = registryMetaFixture({ format });
    readFileMock.mockResolvedValue(
      JSON.stringify({
        ...meta,
        registry: {
          ...meta.registry,
          ...legacyFields,
        },
        authorization: {
          issuer: 'https://untrusted.example.invalid/oauth',
          apiBaseUrl: 'https://untrusted.example.invalid',
        },
      }),
    );
    const registry = {
      shortId: 'cache-short-id',
      descriptor: {
        url: 'git@github.com:UAPKG/Registry.git',
      },
      ensureUpToDate: vi.fn().mockResolvedValue({ ok: true, value: 'Updated', diagnostics: [] }),
    };
    const root = {
      config: {
        get: vi.fn().mockReturnValue('official'),
      },
      registryCore: {
        getOrCreateRegistry: vi.fn().mockReturnValue({ ok: true, value: registry }),
      },
    } as unknown as CompositionRoot;

    const trust = await new RegistryTrustResolver(root).resolve();

    expect(trust).toMatchObject({
      alias: 'default',
      registryId: '00000000-0000-4000-a000-000000000020',
      registryName: 'Official',
      repositoryUrl: 'https://github.com/uapkg/registry.git',
      repositoryFingerprint: fingerprintRegistryGitOrigin('https://github.com/uapkg/registry.git'),
      issuer: 'https://account.uapkg.dev/oauth',
      apiBaseUrl: 'https://api.uapkg.dev',
      resource: 'https://api.uapkg.dev/v1/registries/00000000-0000-4000-a000-000000000020',
    });
    expect(JSON.stringify(trust)).not.toContain('untrusted.example.invalid');
    expect(trust).not.toHaveProperty('registryIdentifier');
  });

  it.each(['reduced', 'rich'] as const)('rejects an unknown %s metadata schema version', async (format) => {
    readFileMock.mockResolvedValue(JSON.stringify(registryMetaFixture({ format, schemaVersion: 2 })));
    const root = {
      config: { get: vi.fn().mockReturnValue('official') },
      registryCore: {
        getOrCreateRegistry: vi.fn().mockReturnValue({
          ok: true,
          value: {
            shortId: 'cache-short-id',
            descriptor: { url: 'https://github.com/uapkg/registry.git' },
            ensureUpToDate: vi.fn().mockResolvedValue({ ok: true, value: 'Updated', diagnostics: [] }),
          },
        }),
      },
    } as unknown as CompositionRoot;

    await expect(new RegistryTrustResolver(root).resolve()).rejects.toThrow('does not match the supported schema');
  });
});
