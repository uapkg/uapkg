import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const managedRuntimeSmokeMajor = process.env.UAPKG_RELEASE_SMOKE_NODE_MAJOR ?? '22';

/** Warm the verified cache on the runner whose platform and ABI the packaged worker must use. */
if (import.meta.main) {
  const cacheRoot = process.env.UAPKG_RELEASE_SMOKE_NODE_CACHE;
  if (!cacheRoot || !path.isAbsolute(cacheRoot))
    throw new Error('Set UAPKG_RELEASE_SMOKE_NODE_CACHE to an absolute path.');
  assert.match(managedRuntimeSmokeMajor, /^\d+$/);
  const { NodeVersionManager } = await import('../../packages/uapkg-node-version-manager/src/index.ts');
  const manager = new NodeVersionManager({ cacheRoot });
  const version = await manager.resolveVersion(managedRuntimeSmokeMajor);
  // Validate the signed checksum, download the host artifact, and execute it before the offline tests.
  const binary = await manager.ensureRuntime(version);
  const identity = execFileSync(binary, ['-p', 'JSON.stringify([process.version,process.platform,process.arch])'], {
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(identity), ['v' + version, process.platform, process.arch]);
  process.stdout.write(`Verified online managed Node ${version} (${process.platform}-${process.arch}).\n`);
}

interface ManagedRuntimeSmoke {
  readonly cache: string;
  readonly profiles: readonly string[];
  readonly project: string;
  readonly name: string;
  readonly major: string;
  readonly run: (...args: string[]) => Promise<{ stdout: string }>;
}

/** Use only a caller-provided verified cache. Corruption exercises disposable profile copies. */
export async function smokeManagedRuntime({
  cache,
  profiles,
  project,
  name,
  major,
  run,
}: ManagedRuntimeSmoke): Promise<void> {
  assert.match(major, /^\d+$/);
  const copies = profiles.map((profile) => path.join(profile, 'cache', 'node-runtimes'));
  const index = await fs.readFile(path.join(cache, 'index.json'));
  for (const copy of copies) {
    await fs.mkdir(copy, { recursive: true });
    await fs.writeFile(path.join(copy, 'index.json'), index);
  }
  const marker = path.join(project, 'managed-worker.jsonl');
  const lockPath = path.join(project, 'uapkg.lock');
  const readLock = async () => JSON.parse(await fs.readFile(lockPath, 'utf8'));
  const readMarker = async () =>
    fs.readFile(marker, 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return '';
      throw e;
    });
  const approve = ['permissions', 'approve', name, '--capability', 'postinstall'];
  const retry = ['lifecycle', 'retry', name, '--capability', 'postinstall'];
  const frozen = ['install', '--frozen', '--json'];
  const add = JSON.parse((await run('add', name + '@1.0.0', '--json')).stdout);
  assert.equal(add.status, 'ok');
  assert(
    add.diagnostics.some(
      (d: { code: string; data: { capability?: string } }) =>
        d.code === 'LIFECYCLE_APPROVAL_REQUIRED' && d.data.capability === 'postinstall',
    ),
  );
  assert.equal((await readLock()).lifecycleRuntimes?.node?.[major], undefined);

  // Approval pins using only the cached official index, without installing a runtime or running the hook.
  await run(...approve);
  const approved = await readLock();
  const pinned = approved.lifecycleRuntimes.node[major];
  assert.equal(pinned.split('.')[0], major);
  assert.equal(await readMarker(), '');
  for (const copy of copies) await assert.rejects(fs.access(path.join(copy, pinned)));

  // Simulate a stale lock while retaining the actual exact-release approval.
  delete approved.lifecycleRuntimes.node[major];
  await fs.writeFile(lockPath, JSON.stringify(approved));
  await assert.rejects(run(...frozen), /No locked Node runtime/);
  assert.equal(await readMarker(), '');
  await run(...approve);
  assert.equal((await readLock()).lifecycleRuntimes.node[major], pinned);
  await assert.rejects(run(...frozen), /explicit lifecycle retry/i);

  let platform = (process.platform === 'win32' ? 'win' : process.platform) + '-' + process.arch;
  if (process.platform === 'linux') {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    if (!report.header?.glibcVersionRuntime) platform += '-musl';
  }
  const payload = process.platform === 'win32' ? 'node.exe' : 'release.tar.gz';
  const release = path.join(pinned, platform);
  const sourcePayload = path.join(cache, release, payload);
  await fs.access(sourcePayload);
  for (const copy of copies) {
    await fs.mkdir(path.join(copy, release), { recursive: true });
    await fs.copyFile(path.join(cache, release, 'SHASUMS256.txt.asc'), path.join(copy, release, 'SHASUMS256.txt.asc'));
  }
  await assert.rejects(run(...retry), /release key snapshot.*offline/i);
  for (const copy of copies) {
    await fs.cp(path.join(cache, 'release-keys'), path.join(copy, 'release-keys'), { recursive: true });
  }
  // A signed manifest without the binary, and then an altered binary, must each fail offline before execution.
  await assert.rejects(run(...retry), /unavailable offline/);
  for (const copy of copies) await fs.writeFile(path.join(copy, release, payload), 'invalid runtime bytes');
  await assert.rejects(run(...retry), /unavailable offline/);
  assert.equal(await readMarker(), '');
  for (const copy of copies) await fs.copyFile(sourcePayload, path.join(copy, release, payload));
  await run(...retry);
  const once = await readMarker();
  const lines = once.trim().split('\n');
  assert.equal(lines.length, 1);
  const executed = JSON.parse(lines[0]);
  assert.equal(executed.version, 'v' + pinned);
  const candidates = copies.map((copy) => path.join(copy, release, process.platform === 'win32' ? 'node.exe' : 'node'));
  assert(candidates.includes(executed.executable), 'The selected managed Node executable must launch the hook');
  await run(...frozen);
  assert.equal(await readMarker(), once);
  process.stdout.write('Packaged offline managed Node smoke passed for ' + pinned + ' (' + platform + ').\n');
}
