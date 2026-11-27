import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vite-plus/test';
import { reconcileWorkspaceIntegration } from '../src/runtime.ts';

vi.mock('web-tree-sitter', () => {
  throw new Error('Descriptor reconciliation loaded the C# parser.');
});

it('reconciles descriptor-only requests and their removal without loading C#', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uapkg-native-ref-'));
  const descriptor = join(root, 'Game.uproject');
  try {
    writeFileSync(descriptor, '{}');
    const input = { workspaceKind: 'project' as const, workspaceRoot: root, integrations: [], complete: true };
    await reconcileWorkspaceIntegration({ ...input, directPlugins: [{ owner: 'package', pluginName: 'MyPlugin' }] });
    expect(JSON.parse(readFileSync(descriptor, 'utf8')).Plugins).toEqual([{ Name: 'MyPlugin', Enabled: true }]);
    await reconcileWorkspaceIntegration({ ...input, directPlugins: [] });
    expect(readFileSync(descriptor, 'utf8')).toBe('{}');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
