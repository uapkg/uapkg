import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { INTERNAL_PROFILE_HOME_ENV } from '@uapkg/common';
import { createConfig } from '@uapkg/config';
import type { VerifiedRelease } from '@uapkg/installer';
import { reconcileIntegration } from '@uapkg/integration';
import { ManifestSchema } from '@uapkg/package-manifest-schema';
import { expect, it, vi } from 'vite-plus/test';
import { runWorkspaceLifecycle, type WorkspaceLifecycleOptions } from '../src/index.ts';

it('runs a shared leaf once, propagates integration failure through empty intermediaries and resumes safely', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'uapkg-diamond-'));
  const workspaceRoot = path.join(temp, 'game');
  try {
    vi.stubEnv(INTERNAL_PROFILE_HOME_ENV, path.join(temp, 'profile'));
    await mkdir(workspaceRoot);
    const project = path.join(workspaceRoot, 'Game.uproject');
    await writeFile(project, '{}');
    const enabled = async () =>
      (JSON.parse(await readFile(project, 'utf8')).Plugins as { Name: string }[]).map((p) => p.Name).sort();
    reconcileIntegration({
      workspaceRoot,
      workspaceKind: 'project',
      directPlugins: [{ owner: 'previous-owner', pluginName: 'Previous' }],
      integrations: [],
      complete: true,
    });
    const graph: Record<string, string[]> = {
      parent: ['left', 'right'],
      left: ['leaf'],
      right: ['leaf'],
      leaf: [],
      unrelated: [],
    };
    const releases: VerifiedRelease[] = [];
    for (const [name, dependencies] of Object.entries(graph)) {
      const source = path.join(temp, name);
      await mkdir(path.join(source, '.uapkg', 'lifecycle'), { recursive: true });
      await writeFile(path.join(source, 'uapkg.json'), JSON.stringify({ name, version: '1.0.0', kind: 'plugin' }));
      await writeFile(path.join(source, name + '.uplugin'), '{}');
      await writeFile(
        path.join(source, '.uapkg/lifecycle/postinstall.mjs'),
        `import fs from 'node:fs'; import path from 'node:path'; export default ({workspaceRoot})=>fs.appendFileSync(path.join(workspaceRoot,'events'),'${name}\\n');`,
      );
      if (['leaf', 'parent', 'unrelated'].includes(name)) {
        const condition =
          name === 'leaf'
            ? "if (!fs.existsSync(path.resolve('../../..','retry-ok'))) throw new Error('fixture failure');"
            : '';
        await writeFile(
          path.join(source, '.uapkg/integration.mjs'),
          `import fs from 'node:fs'; import path from 'node:path'; ${condition} export default {setupProject:{plugins:['${name}Host']}};`,
        );
      }
      releases.push({
        activationId: name,
        packageName: name,
        registry: 'local',
        registryId: '0'.repeat(64),
        version: '1.0.0',
        integrity: ('sha256:' + 'a'.repeat(64)) as VerifiedRelease['integrity'],
        installedPath: path.join(workspaceRoot, 'Plugins', name),
        archivePath: source,
        dependencies,
      });
    }
    const manifest = ManifestSchema.parse({
      name: 'game',
      version: '1.0.0',
      kind: 'project',
      dependencies: { parent: '1.0.0' },
    });
    const config = createConfig({ cwd: workspaceRoot }).getAll();
    const options: WorkspaceLifecycleOptions = {
      workspaceRoot,
      report: { verifiedReleases: releases, failed: [], skipped: [], incompleteClosure: [] },
      manifest,
      config: { ...config, install: { ...config.install, lifecyclePolicy: 'allow' } },
      ignoreScripts: false,
      refresh: false,
      invocation: ['install'],
      withVerifiedSnapshot: (release, use) => use(release.archivePath),
      runtime: {
        pin: async () => {
          throw Error('Unexpected pin');
        },
        executable: async () => {
          throw Error('Unexpected selector');
        },
      },
    };
    const failure = await runWorkspaceLifecycle(options);
    expect(failure).toHaveLength(1);
    expect(failure[0]?.hint).toBe('uapkg lifecycle retry leaf --registry local --capability integration');
    expect(await enabled()).toEqual(['Previous', 'parent', 'unrelatedHost']);
    const events = await readFile(path.join(workspaceRoot, 'events'), 'utf8');
    expect(events.trim().split('\n')).toEqual(['leaf', 'left', 'right', 'parent', 'unrelated']);
    await writeFile(path.join(workspaceRoot, 'retry-ok'), '');
    expect(
      await runWorkspaceLifecycle({
        ...options,
        retry: { packageName: 'leaf', registry: 'local', capability: 'integration' },
      }),
    ).toEqual([]);
    expect(await enabled()).toEqual(['Previous', 'leafHost', 'parent', 'unrelatedHost']);
    expect(await runWorkspaceLifecycle(options)).toEqual([]);
    expect(await enabled()).toEqual(['leafHost', 'parent', 'parentHost', 'unrelatedHost']);
    expect(await readFile(path.join(workspaceRoot, 'events'), 'utf8')).toBe(events);
  } finally {
    vi.unstubAllEnvs();
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);
