import { ok } from '@uapkg/diagnostics';
import type { InstallReport } from '@uapkg/installer';
import { ManifestSchema, type Lockfile, type Manifest } from '@uapkg/package-manifest-schema';
import type { ResolverOptions } from '@uapkg/package-manifest';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CompositionRoot } from '../../src/app/CompositionRoot.ts';
import { AddCommand } from '../../src/commands/AddCommand.ts';
import { InstallCommand } from '../../src/commands/InstallCommand.ts';
import { UpdateCommand } from '../../src/commands/UpdateCommand.ts';
import { AccountManager } from '../../src/control-plane/AccountManager.ts';
import type { AuthMetadataStore } from '../../src/control-plane/AuthMetadataStore.ts';
import { CredentialStore } from '../../src/control-plane/CredentialStore.ts';

const manifest = {
  name: 'auth-isolation',
  version: '1.0.0',
  kind: 'project',
} as unknown as Manifest;

const lockfile = {
  lockfileVersion: 1,
  packages: {},
} as Lockfile;

const report: InstallReport = {
  plan: {
    actions: [],
    summary: {
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      totalBytes: 0,
    },
  },
  outcomes: [],
  installed: [],
  failed: [],
  skipped: [],
  incompleteClosure: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decentralized read command authentication isolation', () => {
  it.each(['add', 'install', 'update'] as const)(
    '%s uses the shared Git/content path without control-plane or native keyring access',
    async (commandName) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const loadKeyring = vi.fn(async () => {
        throw new Error('The native keyring must remain unloaded for decentralized reads.');
      });
      const metadataFind = vi.fn(async () => undefined);
      const accountManager = new AccountManager(
        { find: metadataFind } as unknown as AuthMetadataStore,
        new CredentialStore(loadKeyring),
      );
      const packageManifest = {
        readManifest: vi.fn(async () => ok(manifest)),
        readLockfileOptional: vi.fn(async () => ok(null)),
        addDependency: vi.fn(async () => ok(undefined)),
        installWithReport: vi.fn(async (options: ResolverOptions & { stagedManifest?: Manifest }) =>
          ok({
            manifest: options.stagedManifest ? ManifestSchema.parse(options.stagedManifest) : manifest,
            lockfile,
            previousLockfile: null,
            heldBack: [],
            minimumReleaseAge: '3d',
          }),
        ),
      };
      const installer = {
        getStatusStream: vi.fn(() => emptyStatusStream()),
        execute: vi.fn(async () => ok(report)),
      };
      const root = {
        cwd: 'D:\\project',
        packageManifest,
        installer,
        accountManager,
        config: { get: vi.fn(() => 'official') },
        registryCore: {
          getOrCreateRegistry: vi.fn(() =>
            ok({
              resolvePackage: vi.fn(async () => ok({ version: '1.0.0' })),
            }),
          ),
        },
        json: { emit: vi.fn() },
        diagnostics: { reportAll: vi.fn() },
        postinstall: { run: vi.fn() },
      } as unknown as CompositionRoot;

      const command =
        commandName === 'add'
          ? new AddCommand(root, {
              spec: 'example',
              pin: false,
              dev: false,
              force: false,
              dryRun: true,
              outputFormat: 'json',
            })
          : commandName === 'install'
            ? new InstallCommand(root, {
                force: false,
                frozen: false,
                dryRun: true,
                outputFormat: 'json',
              })
            : new UpdateCommand(root, {
                specs: [],
                force: false,
                dryRun: true,
                outputFormat: 'json',
              });

      await expect(command.execute()).resolves.toBe(0);

      expect(packageManifest.installWithReport).toHaveBeenCalledWith(expect.objectContaining({ frozen: false }));
      expect(packageManifest.addDependency).not.toHaveBeenCalled();
      expect(installer.execute).toHaveBeenCalledOnce();
      expect(metadataFind).not.toHaveBeenCalled();
      expect(loadKeyring).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

async function* emptyStatusStream(): AsyncGenerator<never> {
  yield* [];
}
