import { NodeVersionManager } from '@uapkg/node-version-manager';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import type { CompositionRoot } from '../../src/app/CompositionRoot.ts';
import { WorkspaceRuntime } from '../../src/lifecycle/WorkspaceRuntime.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  ['1', true],
  ['0', false],
])('propagates launcher offline state %s through selection and provisioning', async (value, offline) => {
  vi.stubEnv('UAPKG_OFFLINE', value);
  const pins = { '22': '22.1.0' };
  const root = {
    packageManifest: { readLockfileOptional: async () => ({ ok: true, value: { lifecycleRuntimes: { node: pins } } }) },
  } as unknown as CompositionRoot;
  const select = vi.spyOn(NodeVersionManager.prototype, 'resolveVersion').mockResolvedValue('22.1.0');
  const provision = vi.spyOn(NodeVersionManager.prototype, 'ensureRuntime').mockResolvedValue('node-test');
  expect(await new WorkspaceRuntime(root, { frozen: true }).executable('22')).toBe('node-test');
  expect(select).toHaveBeenCalledWith('22', { pins, frozen: true, offline });
  expect(provision).toHaveBeenCalledWith('22.1.0', { offline });
});
