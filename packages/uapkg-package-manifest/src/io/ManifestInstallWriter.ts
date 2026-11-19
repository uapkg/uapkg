import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createManifestWriteErrorDiagnostic, DiagnosticBag, type Result } from '@uapkg/diagnostics';

interface InstallFile {
  readonly name: 'uapkg.json' | 'uapkg.lock';
  readonly contents: string;
}

interface StagedFile {
  readonly target: string;
  readonly pending: string;
  readonly backup?: string;
  committed: boolean;
  keepBackup: boolean;
}

/** Stage the resolved manifest/lock pair before replacing either existing file. */
export class ManifestInstallWriter {
  async write(manifestRoot: string, files: readonly InstallFile[]): Promise<Result<void>> {
    const bag = new DiagnosticBag();
    const staged: StagedFile[] = [];
    let activePath = manifestRoot;
    try {
      await fs.mkdir(manifestRoot, { recursive: true });
      for (const file of files) {
        activePath = join(manifestRoot, file.name);
        let original: Buffer | undefined;
        let mode: number | undefined;
        let info: Stats | undefined;
        try {
          info = await fs.lstat(activePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (info) {
          if (info.isSymbolicLink()) {
            activePath = await fs.realpath(activePath);
            info = await fs.stat(activePath);
          }
          if (!info.isFile()) throw new Error('Expected a regular manifest or lockfile.');
          original = await fs.readFile(activePath);
          mode = info.mode & 0o777;
        }
        const identity = randomUUID();
        // Existing links keep their identity; replacements are siblings of their actual destination.
        const destinationDirectory = dirname(activePath);
        const entry: StagedFile = {
          target: activePath,
          pending: join(destinationDirectory, `.${file.name}.${identity}.pending`),
          backup: original === undefined ? undefined : join(destinationDirectory, `.${file.name}.${identity}.previous`),
          committed: false,
          keepBackup: false,
        };
        staged.push(entry);
        if (entry.backup) await fs.writeFile(entry.backup, original!, { flag: 'wx', mode });
        await fs.writeFile(entry.pending, file.contents, { flag: 'wx', mode });
      }
      for (const entry of staged) {
        activePath = entry.target;
        await fs.rename(entry.pending, entry.target);
        entry.committed = true;
      }
    } catch (error) {
      bag.add(createManifestWriteErrorDiagnostic(activePath, String(error)));
      for (const entry of [...staged].reverse()) {
        if (!entry.committed) continue;
        try {
          if (entry.backup) await fs.rename(entry.backup, entry.target);
          else await fs.unlink(entry.target);
        } catch (recoveryError) {
          entry.keepBackup = true;
          const recovery = entry.backup ? ` Original bytes remain at ${entry.backup}.` : '';
          bag.add(
            createManifestWriteErrorDiagnostic(
              entry.target,
              `Could not restore the previous file: ${String(recoveryError)}.${recovery}`,
            ),
          );
        }
      }
    } finally {
      for (const entry of staged) {
        const cleanup = [entry.pending, ...(entry.backup && !entry.keepBackup ? [entry.backup] : [])];
        for (const path of cleanup) {
          // Failed cleanup leaves only uniquely named staging files; never delete a user-visible target here.
          await fs.unlink(path).catch(() => undefined);
        }
      }
    }
    return bag.toResult(undefined);
  }
}
