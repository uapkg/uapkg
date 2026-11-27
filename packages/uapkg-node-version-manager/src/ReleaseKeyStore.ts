import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PublicKey } from 'openpgp';
import { NODE_RELEASE_KEYS_REVISION } from '#node-version-manager/NodeReleaseKeys.ts';
import {
  readReleaseKeyArchive,
  snapshotKeys,
  type ReleaseKeySnapshot,
} from '#node-version-manager/ReleaseKeyArchive.ts';
import { ReleaseKeyTree } from '#node-version-manager/ReleaseKeyTree.ts';

const repository = 'https://api.github.com/repos/nodejs/release-keys';
const maxAge = 30 * 24 * 60 * 60 * 1000;
const snapshotLimit = 24 * 1024 * 1024;
const revisionPattern = /^[a-f0-9]{40}$/;

type Download = (url: string, limit: number) => Promise<Buffer>;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function checkedRevision(value: unknown): string {
  if (typeof value !== 'string' || !revisionPattern.test(value)) throw new Error('Invalid Node release key revision.');
  return value;
}

/** Each immutable generation is fully verified before it can be observed by another CLI. */
export class ReleaseKeyStore {
  private readonly directory: string;

  constructor(
    cacheRoot: string,
    private readonly download: Download,
  ) {
    this.directory = join(cacheRoot, 'release-keys', 'snapshots-v1');
  }

  async load(options: { offline?: boolean; force?: boolean } = {}): Promise<readonly PublicKey[]> {
    for (;;) {
      const number = await this.latestGeneration();
      const file = this.slot(number);
      const current = number ? await this.readGeneration(file) : undefined;
      if (options.offline) {
        if (!current)
          throw new Error(
            'No verified Node release key snapshot is available offline. Fetch a managed runtime online first.',
          );
        return snapshotKeys(current);
      }
      if (current && !options.force && (await this.isFresh(file, current.revision))) return snapshotKeys(current);
      if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
        throw new Error('Node release key refresh requires HTTPS certificate verification.');
      }
      const ref = JSON.parse((await this.download(repository + '/git/ref/heads/main', 32_768)).toString('utf8'));
      if (ref?.ref !== 'refs/heads/main' || ref.object?.type !== 'commit') {
        throw new Error('Invalid official Node release key branch reference.');
      }
      const head = checkedRevision(ref.object.sha);
      const checkedAt = Date.now();
      if (current?.revision === head) {
        const keys = await snapshotKeys(current);
        await this.markChecked(file, head, checkedAt);
        if ((await this.latestGeneration()) !== number) continue;
        return keys;
      }
      const floor = current?.revision ?? NODE_RELEASE_KEYS_REVISION;
      if (floor !== head) await this.requireDescendant(floor, head);
      const [treeBytes, bytes] = await Promise.all([
        this.download(repository + '/git/trees/' + head + '?recursive=1', 4 * 1024 * 1024),
        this.download('https://codeload.github.com/nodejs/release-keys/tar.gz/' + head, 4 * 1024 * 1024),
      ]);
      const snapshot: ReleaseKeySnapshot = {
        revision: head,
        certificates: await readReleaseKeyArchive(bytes, head, new ReleaseKeyTree(treeBytes)),
        revocations: current?.revocations ?? {},
      };
      const keys = await snapshotKeys(snapshot);
      if (await this.publish(number + 1, snapshot)) {
        await this.markChecked(this.slot(number + 1), head, checkedAt);
        return keys;
      }
      // A concurrent CLI published from the same base. Re-evaluate its new high-water mark
      // before attempting to activate our candidate, even if our download started earlier.
    }
  }

  private slot(generation: number): string {
    return join(this.directory, generation + '.json');
  }

  private async latestGeneration(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if (code(error) === 'ENOENT') return 0;
      throw error;
    }
    let latest = 0;
    for (const entry of entries) {
      const match = /^([1-9]\d*)\.json$/.exec(entry);
      if (match) latest = Math.max(latest, Number(match[1]));
    }
    if (!Number.isSafeInteger(latest)) throw new Error('Invalid Node release key cache generation.');
    return latest;
  }

  private async readGeneration(file: string): Promise<ReleaseKeySnapshot> {
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > snapshotLimit) throw new Error('Invalid Node release key cache file.');
    const bytes = await readFile(file, 'utf8');
    const body = bytes.slice(65);
    if (bytes[64] !== '\n' || bytes.slice(0, 64) !== sha256(body))
      throw new Error('Cached Node release key snapshot failed its integrity check.');
    const snapshot: ReleaseKeySnapshot = JSON.parse(body);
    checkedRevision(snapshot.revision);
    return snapshot;
  }

  private async isFresh(file: string, revision: string): Promise<boolean> {
    try {
      const receipt = file + '.checked.json';
      if ((await stat(receipt)).size > 1024) return false;
      const record = JSON.parse(await readFile(receipt, 'utf8'));
      if (record?.revision !== revision || !Number.isSafeInteger(record.checkedAt) || record.checkedAt <= 0)
        return false;
      const age = Date.now() - record.checkedAt;
      return age >= 0 && age < maxAge;
    } catch (error) {
      if (code(error) === 'ENOENT' || error instanceof SyntaxError) return false;
      throw error;
    }
  }

  private async markChecked(file: string, revision: string, checkedAt: number): Promise<void> {
    // Cache restores can reset filesystem timestamps. Record the remote observation itself.
    const stage = join(this.directory, randomUUID() + '.tmp');
    try {
      await writeFile(stage, JSON.stringify({ revision, checkedAt }), { flag: 'wx', mode: 0o600, flush: true });
      await rename(stage, file + '.checked.json');
    } finally {
      await rm(stage, { force: true });
    }
  }

  private async requireDescendant(base: string, head: string): Promise<void> {
    const url = repository + '/compare/' + base + '...' + head + '?per_page=1';
    const comparison = JSON.parse((await this.download(url, 4 * 1024 * 1024)).toString('utf8'));
    if (
      comparison?.status !== 'ahead' ||
      !Number.isSafeInteger(comparison.ahead_by) ||
      comparison.ahead_by < 1 ||
      comparison.behind_by !== 0 ||
      comparison.base_commit?.sha !== base ||
      comparison.merge_base_commit?.sha !== base
    ) {
      throw new Error('Refusing a rollback or divergent Node release key history.');
    }
  }

  private async publish(number: number, snapshot: ReleaseKeySnapshot): Promise<boolean> {
    const body = JSON.stringify(snapshot);
    const data = sha256(body) + '\n' + body;
    if (Buffer.byteLength(data) > snapshotLimit)
      throw new Error('Node release key snapshot exceeds the cache size limit.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stage = join(this.directory, randomUUID() + '.tmp');
    try {
      await writeFile(stage, data, { flag: 'wx', mode: 0o600, flush: true });
      try {
        await link(stage, this.slot(number));
        return true;
      } catch (error) {
        if (code(error) === 'EEXIST') return false;
        throw error;
      }
    } finally {
      await rm(stage, { force: true });
    }
  }
}
