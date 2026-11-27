import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveActiveUapkgProfileRoot } from '@uapkg/common';

export interface LifecycleReleaseIdentity {
  /** Issued when the installer activates the package; stable on unchanged installs. */
  activationId: string;
  registry: string;
  registryId: string;
  packageName: string;
  version: string;
  integrity: string;
}

export interface RunLifecycleOnceOptions {
  workspaceRoot: string;
  identity: LifecycleReleaseIdentity;
  kind: 'integration' | 'postinstall';
  retry?: boolean;
}

function releaseKey(identity: LifecycleReleaseIdentity): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        identity.registry,
        identity.registryId,
        identity.packageName,
        identity.version,
        identity.integrity,
        identity.activationId,
      ]),
    )
    .digest('hex');
}

export function getLifecycleWorkDir(workspaceRoot: string, identity: LifecycleReleaseIdentity): string {
  return path.join(workspaceRoot, '.uapkg', 'lifecycle-work', releaseKey(identity));
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

async function readRecord(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid lifecycle record: ' + file);
    return value as Record<string, unknown>;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

function processIsAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0)
    throw new Error('Invalid lifecycle execution record.');
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (errorCode(err) === 'ESRCH') return false;
    if (errorCode(err) === 'EPERM') return true;
    throw err;
  }
}

// Link a complete, immutable record under its final name. Two concurrent installers cannot
// claim the same attempt, and readers never see an empty or half-written JSON document.
async function publish(file: string, value: unknown): Promise<boolean> {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  try {
    await fs.link(temporary, file);
    return true;
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return false;
    throw err;
  } finally {
    await fs.unlink(temporary);
  }
}

/** Only an explicit retry can claim a new attempt following a failure or process interruption. */
export async function runLifecycleOnce<T>(
  options: RunLifecycleOnceOptions,
  execute: () => Promise<T>,
): Promise<{ value: T; reused: boolean }> {
  const workspaceRoot = await fs.realpath(options.workspaceRoot);
  const workspaceKey = createHash('sha256').update(workspaceRoot).digest('hex');
  const directory = path.join(
    resolveActiveUapkgProfileRoot(),
    'state',
    'lifecycle',
    workspaceKey,
    releaseKey(options.identity),
    options.kind,
  );
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (let attempt = 1; ; attempt++) {
    const prefix = path.join(directory, String(attempt));
    const start = await readRecord(prefix + '.started.json');
    if (start) {
      const result = await readRecord(prefix + '.result.json');
      if (result?.status === 'success') return { value: result.value as T, reused: true };
      if (!result && processIsAlive(start.pid))
        throw new Error('Lifecycle execution in progress for ' + options.identity.packageName);
      if (!options.retry && !(await readRecord(path.join(directory, String(attempt + 1) + '.started.json')))) {
        throw new Error(
          'The previous ' +
            options.kind +
            ' attempt for ' +
            options.identity.packageName +
            (result ? ' failed' : ' was interrupted') +
            '. Request an explicit lifecycle retry.',
        );
      }
      continue;
    }
    const { packageName, version, registry, registryId, integrity, activationId } = options.identity;
    const claimed = await publish(prefix + '.started.json', {
      workspaceRoot,
      packageName,
      version,
      registry,
      registryId,
      integrity,
      activationId,
      capability: options.kind,
      pid: process.pid,
      started: new Date().toISOString(),
    });
    if (!claimed) throw new Error('Another lifecycle execution claimed ' + options.identity.packageName + '.');
    let value: T;
    try {
      value = await execute();
    } catch (err) {
      await publish(prefix + '.result.json', { status: 'failed', message: String(err) });
      throw err;
    }
    await publish(prefix + '.result.json', { status: 'success', value });
    return { value, reused: false };
  }
}
