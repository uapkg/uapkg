import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { INTERNAL_PROFILE_HOME_ENV } from '@uapkg/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { discoverEntries, getLifecycleWorkDir, runLifecycleEntry, runLifecycleOnce } from '../src/index.ts';

const directories: string[] = [];
let profile: string;
beforeEach(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'uapkg-lifecycle-profile-'));
  directories.push(profile);
  vi.stubEnv(INTERNAL_PROFILE_HOME_ENV, profile);
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uapkg-lifecycle-test-'));
  directories.push(root);
  await fs.mkdir(path.join(root, '.uapkg/lifecycle'), { recursive: true });
  return root;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
const identity = {
  activationId: 'installed-once',
  registry: 'default',
  registryId: 'registry A',
  packageName: '@a/tool',
  version: '1.0.0',
  integrity: 'sha256:one',
};

describe('lifecycle', () => {
  it('discovers overrides without evaluating code, diagnoses ambiguous, missing and escaping entries', async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, '.uapkg/integration.ts'), 'throw new Error("evaluated")');
    await fs.writeFile(path.join(root, '.uapkg/integration.js'), '');
    expect(() => discoverEntries(root, {})).toThrow(/Ambiguous/);
    expect(discoverEntries(root, { integration: { entry: '.uapkg/integration.js' } })).toEqual({
      integration: '.uapkg/integration.js',
    });
    expect(() => discoverEntries(root, { integration: { entry: 'missing.mjs' } })).toThrow(/missing/);
    expect(() => discoverEntries(root, { integration: { entry: '../outside.ts' } })).toThrow(/relative/);
  });

  it('loads TS, the SDK and a local sibling in a fresh child, without consuming node_modules', async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, '.uapkg/helpers.ts'), 'export const value: number = 72;');
    await fs.writeFile(
      path.join(root, '.uapkg/integration.ts'),
      "import { defineIntegration } from '@uapkg/integration'; import {value} from './helpers.ts'; export default defineIntegration({value, pid:process.pid});",
    );
    const value = (await runLifecycleEntry({
      kind: 'integration',
      packageRoot: root,
      workspaceRoot: root,
      workDir: getLifecycleWorkDir(root, identity),
      entry: '.uapkg/integration.ts',
    })) as { value: number; pid: number };
    expect(value.value).toBe(72);
    expect(value.pid).not.toBe(process.pid);
  });

  it('runs a general script in its work directory with verified package and workspace paths', async () => {
    const root = await fixture(),
      workDir = getLifecycleWorkDir(root, identity);
    await fs.writeFile(
      path.join(root, '.uapkg/lifecycle/postinstall.mjs'),
      "import fs from 'node:fs'; export default ctx => fs.writeFileSync('context.json', JSON.stringify(ctx));",
    );
    await runLifecycleEntry({
      kind: 'postinstall',
      packageRoot: root,
      workspaceRoot: root,
      workDir,
      entry: '.uapkg/lifecycle/postinstall.mjs',
    });
    expect(JSON.parse(await fs.readFile(path.join(workDir, 'context.json'), 'utf8'))).toEqual({
      packageRoot: root,
      workspaceRoot: root,
      workDir,
    });
  });

  it('keeps the source location of a bundled TS helper when reading an authored sibling asset', async () => {
    const root = await fixture();
    const helpers = path.join(root, 'authored');
    await fs.mkdir(helpers);
    await fs.writeFile(path.join(helpers, 'sample.txt'), 'from the verified release');
    await fs.writeFile(
      path.join(helpers, 'asset.ts'),
      "import fs from 'node:fs'; export function read(): string { return fs.readFileSync(new URL('./sample.txt', import.meta.url), 'utf8'); }",
    );
    await fs.writeFile(
      path.join(root, '.uapkg/integration.ts'),
      "import {read} from '../authored/asset.ts'; export default { value:read() };",
    );
    const source = {
      packageRoot: root,
      workspaceRoot: root,
      workDir: getLifecycleWorkDir(root, identity),
      entry: '.uapkg/integration.ts',
      kind: 'integration' as const,
    };
    expect(await runLifecycleEntry(source)).toEqual({ value: 'from the verified release' });
    await fs.writeFile(path.join(root, '.uapkg/integration.ts'), "import 'external-module'; export default {};");
    await expect(runLifecycleEntry(source)).rejects.toThrow(/Bundle third-party/);
    const outside = await fixture();
    await fs.writeFile(path.join(outside, 'helper.ts'), 'export const value = 1;');
    const link = path.join(root, 'linked');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(
      path.join(root, '.uapkg/integration.ts'),
      "import {value} from '../linked/helper.ts'; export default {value};",
    );
    await expect(runLifecycleEntry(source)).rejects.toThrow(/outside the package/);
    expect(() => discoverEntries(root, { integration: { entry: 'linked/helper.ts' } })).toThrow(/outside the package/);
  });

  it('requires an explicit retry after failure and reuses success per exact release/capability', async () => {
    const workspaceRoot = await fixture();
    const options = { workspaceRoot, identity, kind: 'integration' as const };
    let executions = 0;
    const run = () => {
      executions++;
      return Promise.resolve({ value: executions });
    };
    await expect(
      runLifecycleOnce(options, async () => {
        throw new Error('fixture failure');
      }),
    ).rejects.toThrow('fixture failure');
    await expect(runLifecycleOnce(options, run)).rejects.toThrow(/explicit/);
    expect(await runLifecycleOnce({ ...options, retry: true }, run)).toEqual({ value: { value: 1 }, reused: false });
    expect(await runLifecycleOnce(options, run)).toEqual({ value: { value: 1 }, reused: true });
    await runLifecycleOnce({ ...options, identity: { ...identity, registryId: 'registry B' } }, run);
    expect(executions).toBe(2);
  });

  it('does not race an active execution and only retries an interrupted attempt explicitly', async () => {
    const workspaceRoot = await fixture();
    const options = { workspaceRoot, identity, kind: 'postinstall' as const };
    let signalStarted!: () => void;
    let signalDone!: () => void;
    const running = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const done = new Promise<void>((resolve) => {
      signalDone = resolve;
    });
    const first = runLifecycleOnce(options, async () => {
      signalStarted();
      await done;
      throw new Error('failed');
    });
    await running;
    await expect(runLifecycleOnce({ ...options, retry: true }, async () => 'unexpected')).rejects.toThrow(/progress/);
    signalDone();
    await expect(first).rejects.toThrow('failed');
    const key = path.basename(getLifecycleWorkDir(workspaceRoot, identity));
    const journals = path.join(profile, 'state', 'lifecycle');
    const [workspaceKey] = await fs.readdir(journals);
    const directory = path.join(journals, workspaceKey, key, 'postinstall');
    const started = JSON.parse(await fs.readFile(path.join(directory, '1.started.json'), 'utf8'));
    expect(started).toMatchObject({
      ...identity,
      workspaceRoot: await fs.realpath(workspaceRoot),
      capability: 'postinstall',
    });
    await fs.unlink(path.join(directory, '1.result.json'));
    await fs.writeFile(path.join(directory, '1.started.json'), JSON.stringify({ pid: 2_147_483_647 }));
    await expect(runLifecycleOnce(options, async () => 'unexpected')).rejects.toThrow(/interrupted/);
    expect(await runLifecycleOnce({ ...options, retry: true }, async () => 'retried')).toEqual({
      value: 'retried',
      reused: false,
    });
  });

  it('runs once per genuine activation even when returning to the same verified release', async () => {
    const workspaceRoot = await fixture();
    let count = 0;
    const run = async () => ++count;
    async function install(active: typeof identity) {
      const config = { workspaceRoot, identity: active, kind: 'postinstall' as const };
      const first = await runLifecycleOnce(config, run);
      const unchanged = await runLifecycleOnce(config, run);
      expect(unchanged).toEqual({ value: first.value, reused: true });
      return first;
    }
    expect(await install(identity)).toEqual({ value: 1, reused: false });
    expect(await install({ ...identity, version: '2.0.0', integrity: 'sha256:two', activationId: 'upgrade' })).toEqual({
      value: 2,
      reused: false,
    });
    expect(await install({ ...identity, activationId: 'downgrade' })).toEqual({ value: 3, reused: false });
    const reinstalled = { ...identity, activationId: 'removed-and-readded' };
    expect(await install(reinstalled)).toEqual({ value: 4, reused: false });
    expect(getLifecycleWorkDir(workspaceRoot, reinstalled)).not.toBe(getLifecycleWorkDir(workspaceRoot, identity));
  });

  it('keeps receipts in the active profile, scopes copies independently, and shares history through a workspace alias', async () => {
    const workspaceRoot = await fixture();
    const options = { workspaceRoot, identity, kind: 'postinstall' as const };
    let executions = 0;
    const run = async () => ++executions;
    await runLifecycleOnce(options, run);
    expect(await fs.readdir(path.join(workspaceRoot, '.uapkg'))).toEqual(['lifecycle']);
    const copy = await fixture();
    await fs.cp(workspaceRoot, copy, { recursive: true });
    expect((await runLifecycleOnce({ ...options, workspaceRoot: copy }, run)).reused).toBe(false);
    const alias = path.join(await fixture(), 'workspace-link');
    await fs.symlink(workspaceRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await runLifecycleOnce({ ...options, workspaceRoot: alias }, run)).reused).toBe(true);
    vi.stubEnv(INTERNAL_PROFILE_HOME_ENV, path.join(profile, 'second-profile'));
    expect((await runLifecycleOnce(options, run)).reused).toBe(false);
    expect(executions).toBe(3);
  });
});
