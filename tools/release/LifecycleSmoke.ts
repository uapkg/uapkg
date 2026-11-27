import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { managedRuntimeSmokeMajor, smokeManagedRuntime } from './ManagedLifecycleSmoke.ts';

interface Output {
  pid: number;
  stdout: string;
}
interface Envelope {
  status: string;
  diagnostics: {
    code: string;
    data?: {
      packageName?: string;
      capability?: string;
      registry?: string;
      approveCommand?: string;
      retryCommand?: string;
    };
  }[];
}
interface RecordFile {
  name: string;
  packageSource: { type: 'git'; url: string };
  versions: Record<string, unknown>;
}
const version = '1.0.0';
const leaf = 'smoke-leaf';
const parent = 'smoke-parent';
const silent = 'smoke-silent';
const leafPlugin = 'FixtureLeaf';
const parentPlugin = 'FixtureParent';
const silentPlugin = 'FixtureSilent';

async function write(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}
function json(file: string, value: unknown) {
  return write(file, JSON.stringify(value, null, 2));
}
async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function denied(result: Output) {
  const envelope: Envelope = JSON.parse(result.stdout);
  assert.equal(envelope.status, 'ok', result.stdout);
  return envelope.diagnostics.filter((d) => d.code === 'LIFECYCLE_APPROVAL_REQUIRED').map((d) => d.data!);
}
function pluginNames(doc: { Plugins?: { Name: string; Enabled: boolean }[] }) {
  return (doc.Plugins ?? [])
    .filter((p) => p.Enabled)
    .map((p) => p.Name)
    .sort();
}

/** Exercise the shipped CLI, including its packaged child worker and release-verification boundary. */
export async function smokeLifecycle(executable: string, engineArgs: readonly string[]): Promise<void> {
  const engine = /[/\\]/.test(executable) ? path.resolve(executable) : executable;
  const prefix = await Promise.all(
    engineArgs.map(async (arg) => {
      if (arg.startsWith('-')) return arg;
      return (await fs.stat(arg).catch(() => undefined))?.isFile() ? path.resolve(arg) : arg;
    }),
  );
  // macOS can spell the temporary directory differently from process.cwd() and process.execPath.
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'uapkg-release-lifecycle-')));
  const home = path.join(temp, 'home');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    UAPKG_INTERNAL_CONFIG_CACHE_HOME: path.join(home, '.uapkg'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const artifacts = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    const body = artifacts.get(req.url ?? '');
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
  });
  function run(cwd: string, ...args: string[]): Promise<Output> {
    return runWithEnvironment(cwd, env, ...args);
  }
  function runWithEnvironment(cwd: string, environment: NodeJS.ProcessEnv, ...args: string[]): Promise<Output> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        engine,
        [...prefix, ...args],
        { cwd, env: environment, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error)
            reject(
              new Error(
                `Packaged CLI ${args.join(' ')} failed in ${path.basename(cwd)}:\n${stdout}\n${stderr}\n${error.message}`,
              ),
            );
          else resolve({ pid: child.pid!, stdout });
        },
      );
    });
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const primary = origin + '/registry-a';
    const secondary = origin + '/registry-b';
    const ref = { type: 'branch', value: 'main' };
    const config = (url: string) => ({
      registry: 'default',
      registries: { default: { url, ref, ttlSeconds: 86400 }, secondary: { url: secondary, ref, ttlSeconds: 86400 } },
      network: { retries: 0 },
    });
    // Both public distribution modes select their own profile suffix at startup.
    const profiles = [path.join(home, '.uapkg'), path.join(home, '.uapkg-development')];
    async function seed(url: string, records: RecordFile[]) {
      // The cache key is the SHA-256 of the sorted identity fields.
      const registryIdentifier = sha256(JSON.stringify({ ref, url }));
      for (const profile of profiles) {
        const cache = path.join(profile, 'registry', registryIdentifier.slice(0, 16));
        await json(path.join(cache, 'registry.json'), {
          registryIdentifier,
          lastRegistrySyncAt: Math.floor(Date.now() / 1000),
        });
        await json(path.join(cache, 'registry', '.uapkg', 'registry.meta.json'), {
          schemaVersion: 1,
          registry: { id: '00000000-0000-4000-a000-000000000020', name: 'Loopback registry', registryType: 'private' },
        });
        for (const record of records)
          await json(path.join(cache, 'registry', 'packages', record.name[0], record.name + '.json'), record);
      }
    }
    async function pack(name: string, dependencies: Record<string, string> = {}): Promise<RecordFile> {
      const dir = path.join(temp, 'authors', name);
      const out = path.join(temp, name + '.tgz');
      const packed = await run(dir, 'pack', '--outFile', out);
      if (name === leaf) {
        const generated = await readJson(path.join(dir, 'generated-by-prepack.json'));
        assert.equal(generated.value, 'from the sibling module');
        assert.notEqual(generated.pid, packed.pid);
      }
      const bytes = await fs.readFile(out);
      const resource = '/assets/' + name + '.tgz';
      artifacts.set(resource, bytes);
      return {
        name,
        packageSource: { type: 'git', url: primary },
        versions: {
          [version]: {
            meta: { publishedAt: 1700000000 },
            gitTree: 'a'.repeat(40),
            private: false,
            dependencies,
            releaseFiles: {
              package: { url: origin + resource, integrity: { hash: 'sha256:' + sha256(bytes), size: bytes.length } },
            },
          },
        },
      };
    }
    async function author(name: string, plugin: string, extra: Record<string, unknown> = {}) {
      const dir = path.join(temp, 'authors', name);
      await json(path.join(dir, 'uapkg.json'), { kind: 'plugin', name, version, ...extra });
      await json(path.join(dir, plugin + '.uplugin'), { FileVersion: 3 });
      await json(path.join(dir, '.uapkg', 'config.json'), config(primary));
      return dir;
    }
    const leafDir = await author(leaf, leafPlugin, { integration: { entry: '.uapkg/host.ts' } });
    await write(
      path.join(leafDir, '.uapkg', 'value.mjs'),
      "export const value = 'from the sibling module';\nexport const hostPlugin = 'HostCapability';\n",
    );
    await write(
      path.join(leafDir, '.uapkg', 'lifecycle', 'prepack.ts'),
      [
        "import fs from 'node:fs'; import path from 'node:path'; import {value} from '../value.mjs';",
        "export default ({packageRoot}: {packageRoot:string}) => fs.writeFileSync(path.join(packageRoot,'generated-by-prepack.json'), JSON.stringify({value,pid:process.pid}));",
      ].join('\n'),
    );
    await write(
      path.join(leafDir, '.uapkg', 'lifecycle', 'postinstall.ts'),
      [
        "import fs from 'node:fs'; import path from 'node:path'; import {value} from '../value.mjs';",
        'export default ({workspaceRoot,workDir}: {workspaceRoot:string;workDir:string}) => {',
        "if (path.resolve(process.cwd()) !== path.resolve(workDir)) throw new Error('Unexpected hook work directory');",
        "fs.appendFileSync(path.join(workspaceRoot,'hook-runs.jsonl'),JSON.stringify({value,pid:process.pid})+'\\n'); };",
      ].join('\n'),
    );
    await write(
      path.join(leafDir, '.uapkg', 'host.ts'),
      [
        "import {defineIntegration} from '@uapkg/integration'; import {hostPlugin} from './value.mjs';",
        'const name:string=hostPlugin; export default defineIntegration({setupProject:{plugins:[name]},',
        'setupTargets:[{select:["GameEOS"], includes:"using System.Collections.Generic;",',
        'constructorBody:\'GlobalDefinitions.Add("SMOKE_EOS=1");\'}]});',
      ].join('\n'),
    );
    const records = [await pack(leaf)];
    await seed(primary, records);
    const silentDeps = { [leaf]: version };
    const silentDir = await author(silent, silentPlugin, { dependencies: silentDeps });
    await run(silentDir, 'install', '--ignore-scripts', '--json');
    records.push(await pack(silent, silentDeps));
    await seed(primary, records);
    const deps = { [leaf]: version, [silent]: version };
    const parentDir = await author(parent, parentPlugin, { dependencies: deps });
    await write(
      path.join(parentDir, '.uapkg', 'lifecycle', 'postinstall.mjs'),
      "export default () => { throw new Error('Unapproved parent hook ran'); };",
    );
    await run(parentDir, 'install', '--ignore-scripts', '--json');
    assert.deepEqual(pluginNames(await readJson(path.join(parentDir, parentPlugin + '.uplugin'))), [
      leafPlugin,
      silentPlugin,
    ]);
    records.push(await pack(parent, deps));
    await seed(primary, records);
    await seed(secondary, records);
    const project = path.join(temp, 'game');
    const manifest = path.join(project, 'uapkg.json');
    const descriptor = path.join(project, 'Game.uproject');
    const runs = path.join(project, 'hook-runs.jsonl');
    const localConfig = path.join(project, '.uapkg', 'config.json');
    await json(manifest, { name: 'smoke-game', kind: 'project', version });
    await json(descriptor, { FileVersion: 3 });
    await write(
      path.join(project, 'Source/Game.Target.cs'),
      'using UnrealBuildTool;\npublic class GameTarget : TargetRules { public GameTarget(TargetInfo t) : base(t) {} }\n',
    );
    const derivedTarget = path.join(project, 'Source/GameEOS.Target.cs');
    await write(
      derivedTarget,
      [
        'global using System;',
        'using UnrealBuildTool;',
        'public class GameEOSTarget : GameTarget {',
        '#if false',
        '  public GameEOSTarget(TargetInfo ignored) : base(ignored) {}',
        '#endif',
        '  public GameEOSTarget(TargetInfo t) : base(t) {}',
        '}',
        '',
      ].join('\n'),
    );
    await json(localConfig, config(primary));
    const add = ['add', parent + '@' + version, '--json'];
    const blocked = denied(await run(project, ...add));
    assert.deepEqual(blocked.map((d) => [d.packageName, d.capability].join('/')).sort(), [
      leaf + '/integration',
      leaf + '/postinstall',
      parent + '/postinstall',
    ]);
    assert.deepEqual(pluginNames(await readJson(descriptor)), [parentPlugin]);
    assert.equal(await fs.readFile(runs, 'utf8').catch(() => ''), '');
    const installed = path.join(project, 'Plugins', leaf);
    assert.equal((await readJson(path.join(installed, 'generated-by-prepack.json'))).value, 'from the sibling module');
    await assert.rejects(fs.access(path.join(project, 'Plugins', parent, 'Plugins', leaf)));
    const installedEntry = path.join(installed, '.uapkg', 'lifecycle', 'postinstall.ts');
    const tampered = "throw new Error('Executed the edited installed file instead of the verified release');";
    await write(installedEntry, tampered);
    const approve = async (capability: string) => {
      const diagnostic = blocked.find((d) => d.packageName === leaf && d.capability === capability)!;
      assert.equal(
        diagnostic.approveCommand,
        `uapkg permissions approve ${leaf} --registry default --capability ${capability}`,
      );
      assert.equal(diagnostic.retryCommand, 'uapkg ' + add.join(' '));
      if (capability === 'postinstall') await run(project, ...diagnostic.approveCommand!.split(' ').slice(1));
      else await run(project, 'permissions', 'approve', leaf, '--capability', capability);
    };
    await approve('postinstall');
    const retry = await run(project, ...add);
    assert.deepEqual(
      denied(retry)
        .map((d) => d.capability + '/' + d.packageName)
        .sort(),
      ['integration/' + leaf, 'postinstall/' + parent],
    );
    const once = await fs.readFile(runs, 'utf8');
    const result = JSON.parse(once.trim());
    assert.equal(result.value, 'from the sibling module');
    assert.notEqual(result.pid, retry.pid);
    assert.equal(await fs.readFile(installedEntry, 'utf8'), tampered);
    await approve('integration');
    const frozen = ['install', '--frozen', '--json'];
    assert.deepEqual(
      denied(await run(project, ...frozen)).map((d) => d.packageName),
      [parent],
    );
    assert.deepEqual(pluginNames(await readJson(descriptor)), [parentPlugin, 'HostCapability'].sort());
    const editedTarget = await fs.readFile(derivedTarget, 'utf8');
    assert.match(editedTarget, /global using System;[\s\S]*using System\.Collections\.Generic;/);
    assert.match(editedTarget, /#endif[\s\S]*UAPKG-BEGIN integration:constructorBody\s+\{\s+GlobalDefinitions\.Add/);
    await run(project, ...frozen);
    assert.equal(await fs.readFile(derivedTarget, 'utf8'), editedTarget);
    assert.equal(await fs.readFile(runs, 'utf8'), once);
    const grants = (await readJson(manifest)).permissions;
    assert.deepEqual(
      grants.releases.map((r: { capabilities: string[] }) => r.capabilities),
      [['integration', 'postinstall']],
    );
    // The tag and tarball bytes are identical on both registry identities. Neither the alias nor a previous grant can authorize the other origin.
    await json(localConfig, config(secondary));
    assert.deepEqual(
      denied(await run(project, ...frozen))
        .map((d) => d.packageName + '/' + d.capability)
        .sort(),
      blocked.map((d) => d.packageName + '/' + d.capability).sort(),
    );
    assert.deepEqual((await readJson(manifest)).permissions, grants);
    const historical = grants.releases[0];
    const listed = (await run(project, 'permissions', 'list')).stdout;
    for (const identityField of [leaf + '@' + version, historical.registryId, historical.integrity]) {
      assert(listed.includes(identityField), 'permissions list must identify the saved grant: ' + identityField);
    }
    await run(
      project,
      'permissions',
      'revoke',
      leaf,
      '--capability',
      'postinstall',
      '--integrity',
      historical.integrity,
      '--registry-id',
      historical.registryId,
    );
    assert.deepEqual((await readJson(manifest)).permissions.releases, [
      { ...historical, capabilities: ['integration'] },
    ]);
    assert.equal(await fs.readFile(runs, 'utf8'), once);
    const other = path.join(temp, 'other');
    await json(path.join(other, 'uapkg.json'), {
      name: 'other-project',
      kind: 'project',
      version,
      permissions: grants,
    });
    await json(path.join(other, 'Other.uproject'), { FileVersion: 3 });
    await json(path.join(other, '.uapkg/config.json'), config(primary));
    assert.deepEqual(
      denied(await run(other, 'add', leaf + '@' + version, '--registry', 'secondary', '--json'))
        .map((d) => [d.registry, d.capability].join('/'))
        .sort(),
      ['secondary/integration', 'secondary/postinstall'],
    );
    assert.deepEqual((await readJson(path.join(other, 'uapkg.json'))).permissions, grants);
    const capability = ['--capability', 'postinstall'];
    for (const [command, action] of [
      ['permissions', 'approve'],
      ['permissions', 'revoke'],
      ['lifecycle', 'retry'],
    ] as const) {
      await assert.rejects(run(other, command, action, leaf, ...capability), (error: Error) => {
        assert.match(error.message, /PACKAGE_REGISTRY_AMBIGUOUS/);
        assert.match(error.message, /--registry default/);
        assert.match(error.message, /--registry secondary/);
        return true;
      });
    }
    assert.deepEqual((await readJson(path.join(other, 'uapkg.json'))).permissions, grants);
    const otherRuns = path.join(other, 'hook-runs.jsonl');
    await assert.rejects(fs.access(otherRuns), { code: 'ENOENT' });
    await run(other, 'permissions', 'approve', leaf, '--registry', 'secondary', ...capability);
    await run(other, 'install', '--frozen');
    assert.equal(JSON.parse((await fs.readFile(otherRuns, 'utf8')).trim()).value, 'from the sibling module');
    const managedCache = process.env.UAPKG_RELEASE_SMOKE_NODE_CACHE;
    if (managedCache) {
      const major = managedRuntimeSmokeMajor;
      const name = 'smoke-managed-runtime';
      const authored = await author(name, 'ManagedRuntime', { lifecycle: { runtime: { node: major } } });
      await write(
        path.join(authored, '.uapkg/lifecycle/postinstall.mjs'),
        [
          "import fs from 'node:fs'; import path from 'node:path';",
          "export default ({workspaceRoot}) => fs.appendFileSync(path.join(workspaceRoot,'managed-worker.jsonl'),",
          " JSON.stringify({executable:process.execPath,version:process.version})+'\\n');",
        ].join('\n'),
      );
      await seed(primary, [await pack(name)]);
      const managedProject = path.join(temp, 'managed-game');
      await json(path.join(managedProject, 'uapkg.json'), { kind: 'project', name: 'managed-game', version });
      await json(path.join(managedProject, 'ManagedGame.uproject'), { FileVersion: 3 });
      await json(path.join(managedProject, '.uapkg/config.json'), config(primary));
      await smokeManagedRuntime({
        cache: path.resolve(managedCache),
        profiles,
        project: managedProject,
        name,
        major,
        run: (...args) => runWithEnvironment(managedProject, { ...env, UAPKG_OFFLINE: '1' }, ...args),
      });
    }
    process.stdout.write(
      'Packaged lifecycle smoke passed: prepack, verified postinstall retry, SDK integration, native references, exact registry grants and unchanged installs.\n',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [engine, ...args] = process.argv.slice(2);
  if (!engine) throw new Error('Usage: node tools/release/LifecycleSmoke.ts <engineExecutable> [...engineArgs]');
  await smokeLifecycle(engine, args);
}
