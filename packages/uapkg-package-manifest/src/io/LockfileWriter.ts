import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createManifestWriteErrorDiagnostic, DiagnosticBag, ok, type Result } from '@uapkg/diagnostics';
import type { Lockfile } from '@uapkg/package-manifest-schema';

const LOCKFILE_FILENAME = 'uapkg.lock';

/**
 * Writes `uapkg.lock` to a given root directory.
 */
export class LockfileWriter {
  async write(manifestRoot: string, lockfile: Lockfile): Promise<Result<void>> {
    const bag = new DiagnosticBag();
    const filePath = join(manifestRoot, LOCKFILE_FILENAME);

    try {
      if (!existsSync(manifestRoot)) {
        await mkdir(manifestRoot, { recursive: true });
      }
      await writeFile(filePath, this.serialize(lockfile), 'utf-8');
      return ok(undefined);
    } catch (err) {
      bag.add(createManifestWriteErrorDiagnostic(filePath, String(err)));
      return bag.toFailure();
    }
  }

  serialize(lockfile: Lockfile): string {
    return `${JSON.stringify(lockfile, null, 2)}\n`;
  }
}
