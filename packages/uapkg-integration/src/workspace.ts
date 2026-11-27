import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const ownershipFile = 'uapkg.integration-ownership.json';
const journalFile = '.uapkg/integration-transaction.json';
const fileChange = z.strictObject({ file: z.string(), before: z.string().nullable(), after: z.string().nullable() });
type Change = z.infer<typeof fileChange>;
const journal = z.strictObject({
  version: z.literal(1),
  pid: z.number().int().nonnegative(),
  changes: z.array(fileChange).nonempty(),
});

/** Only the workspace's own descriptors and Unreal source files can be edited, including during recovery. */
function isWritableFile(file: string): boolean {
  if (file === ownershipFile) return true;
  if (/^[^/\\:]+\.u(?:project|plugin)$/i.test(file)) return true;
  return /^Source\/.+\.(?:Build|Target)\.cs$/i.test(file);
}

function checkedPath(root: string, relative: string): string {
  const segments = relative.split('/');
  if (segments.some((name) => !name || name === '.' || name === '..' || /[\\:\0]/.test(name))) {
    throw new Error(`Unsafe workspace path: ${relative}`);
  }
  let current = root;
  for (const name of segments) {
    current = path.join(current, name);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`Workspace path traverses a link: ${relative}`);
  }
  return current;
}

function read(file: string): string | null {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

function stage(file: string, contents: string, mode: number): string {
  const temp = path.join(path.dirname(file), `.uapkg-${randomUUID()}.tmp`);
  fs.writeFileSync(temp, contents, { flag: 'wx', mode, flush: true });
  return temp;
}

function atomicWrite(file: string, contents: string | null): void {
  if (contents === null) {
    fs.unlinkSync(file);
    return;
  }
  const mode = fs.lstatSync(file, { throwIfNoEntry: false })?.mode ?? 0o666;
  const temp = stage(file, contents, mode);
  try {
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function live(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export class Workspace {
  readonly root: string;
  private readonly installedRoots: string[];
  private readonly original = new Map<string, string | null>();
  private readonly updated = new Map<string, string | null>();
  constructor(root: string, installedRoots: readonly string[] = []) {
    this.root = fs.realpathSync(root);
    this.installedRoots = installedRoots.map((dir) => path.resolve(this.root, dir));
    this.recover();
  }
  installed(relative: string): boolean {
    const full = path.resolve(this.root, relative);
    return this.installedRoots.some((dir) => {
      const sub = path.relative(dir, full);
      return sub === '' || (sub !== '..' && !sub.startsWith('..' + path.sep) && !path.isAbsolute(sub));
    });
  }
  path(relative: string): string {
    if (this.installed(relative)) throw new Error(`Integration target belongs to an installed package: ${relative}`);
    return checkedPath(this.root, relative);
  }
  get(file: string): string | null {
    if (!this.original.has(file)) this.original.set(file, read(this.path(file)));
    return this.updated.has(file) ? this.updated.get(file)! : this.original.get(file)!;
  }
  set(file: string, after: string | null): void {
    if (!isWritableFile(file)) throw new Error(`Invalid integration target: ${file}`);
    this.get(file);
    this.updated.set(file, after);
  }
  commit(): string[] {
    const changes: Change[] = [];
    for (const [file, after] of this.updated) {
      const before = this.original.get(file)!;
      if (before !== after) changes.push({ file, before, after });
    }
    if (!changes.length) return [];
    // Publish the complete journal with a no-overwrite atomic link before the first edit.
    const target = this.path(journalFile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    this.check(changes, false);
    const temp = stage(target, JSON.stringify({ version: 1, pid: process.pid, changes }), 0o600);
    try {
      fs.linkSync(temp, target);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    // A competing transaction might have finished while we were planning. Reject stale input
    // before editing and leave the workspace free for the next attempt.
    try {
      this.check(changes, false);
    } catch (error) {
      fs.unlinkSync(target);
      throw error;
    }
    try {
      this.apply(changes);
    } catch (error) {
      // Release the process claim after a recoverable I/O failure in a long-running consumer.
      atomicWrite(target, JSON.stringify({ version: 1, pid: 0, changes }));
      throw error;
    }
    fs.unlinkSync(target);
    return changes.map((change) => change.file);
  }
  private recover(): void {
    const target = this.path(journalFile);
    const raw = read(target);
    if (raw === null) return;
    const parsed = journal.parse(JSON.parse(raw));
    if (parsed.pid && live(parsed.pid))
      throw new Error('Another integration transaction is in progress. Retry when it finishes.');
    const recovery = this.claimRecovery(raw);
    try {
      if (read(target) !== raw) return; // Another process completed recovery first.
      this.check(parsed.changes, true);
      this.apply(parsed.changes);
      fs.unlinkSync(target);
    } finally {
      fs.rmSync(recovery, { force: true });
    }
  }
  /** A crashed recovery cannot hold its successor hostage. Each claimant has its own immutable slot. */
  private claimRecovery(raw: string): string {
    const id = createHash('sha256').update(raw).digest('hex');
    const base = '.uapkg/integration-recovery-' + id;
    for (let slot = 0; ; slot++) {
      const file = this.path(base + '-' + slot + '.json');
      const temp = stage(file, JSON.stringify(process.pid), 0o600);
      try {
        fs.linkSync(temp, file);
        return file;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const claim = read(file);
        if (claim !== null && live(z.number().int().positive().parse(JSON.parse(claim)))) {
          throw new Error('Another process is recovering the integration transaction. Retry when it finishes.');
        }
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
  }
  private check(changes: Change[], allowApplied: boolean): void {
    const seen = new Set<string>();
    for (const c of changes) {
      if (!isWritableFile(c.file) || seen.has(c.file))
        throw new Error(`Invalid integration transaction target: ${c.file}`);
      seen.add(c.file);
      const full = this.path(c.file);
      const actual = read(full);
      if (actual !== c.before && !(allowApplied && actual === c.after)) {
        throw new Error(
          `Integration conflict in ${c.file}: the file changed during the transaction. Preserve your edits and resolve the difference before retrying.`,
        );
      }
      fs.accessSync(path.dirname(full), fs.constants.W_OK);
      if (actual !== null && actual !== c.after) {
        if (!(fs.statSync(full).mode & 0o222))
          throw new Error(`Integration target is read-only: ${c.file}. Make the file writable before retrying.`);
        fs.accessSync(full, fs.constants.W_OK);
      }
    }
  }
  private apply(changes: Change[]): void {
    for (const change of changes) {
      const file = this.path(change.file);
      const actual = read(file);
      if (actual === change.after) continue;
      if (actual !== change.before)
        throw new Error(`Integration conflict: ${change.file} changed before its edit could be applied.`);
      atomicWrite(file, change.after);
    }
  }
}
