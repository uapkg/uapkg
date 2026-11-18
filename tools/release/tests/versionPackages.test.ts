import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vite-plus/test';
import { ProcessRunner } from '../../dev-build/ProcessRunner.ts';
import { syncLauncherVersion } from '../../launcher/LauncherVersion.ts';
import { versionPackages } from '../versionPackages.ts';

vi.mock('../../launcher/LauncherVersion.ts', () => ({ syncLauncherVersion: vi.fn() }));

const root = path.resolve('version-command-workspace');
let run: MockInstance<ProcessRunner['run']>;

beforeEach(() => {
  run = vi.spyOn(ProcessRunner.prototype, 'run').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(syncLauncherVersion).mockReset();
});

describe('workspace version command', () => {
  it('runs Changesets before synchronizing Cargo and forwards version options', () => {
    versionPackages(root, ['--', '--ignore', 'ignored-package']);

    expect(run).toHaveBeenCalledExactlyOnceWith(
      'vp',
      ['exec', 'changeset', 'version', '--ignore', 'ignored-package'],
      root,
    );
    expect(syncLauncherVersion).toHaveBeenCalledExactlyOnceWith(root);
    expect(run.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(syncLauncherVersion).mock.invocationCallOrder[0]!);
  });

  it.each([['--snapshot', 'beta'], ['--snapshot=beta']])(
    'rejects snapshot option %s before any version changes',
    (...args) => {
      expect(() => versionPackages(root, args)).toThrow('Snapshot versions are not supported');
      expect(run).not.toHaveBeenCalled();
      expect(syncLauncherVersion).not.toHaveBeenCalled();
    },
  );

  it('synchronizes Cargo when Changesets succeeds without any changes', () => {
    versionPackages(root);

    expect(run).toHaveBeenCalledExactlyOnceWith('vp', ['exec', 'changeset', 'version'], root);
    expect(syncLauncherVersion).toHaveBeenCalledExactlyOnceWith(root);
  });

  it('preserves a Changesets failure without attempting Cargo synchronization', () => {
    const error = new Error('Changesets could not version the workspace');
    run.mockImplementation(() => {
      throw error;
    });

    expect(() => versionPackages(root)).toThrow(error);
    expect(syncLauncherVersion).not.toHaveBeenCalled();
  });

  it('propagates synchronization failures and retries synchronization on the next invocation', () => {
    const error = new Error('Cargo synchronization failed');
    vi.mocked(syncLauncherVersion).mockImplementationOnce(() => {
      throw error;
    });

    expect(() => versionPackages(root)).toThrow(error);
    expect(() => versionPackages(root)).not.toThrow();

    expect(run).toHaveBeenCalledTimes(2);
    expect(syncLauncherVersion).toHaveBeenCalledTimes(2);
    expect(run.mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(syncLauncherVersion).mock.invocationCallOrder[1]!);
  });
});
