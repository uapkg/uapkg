import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { InstallPath } from '@uapkg/common-schema';
import { createExtractionFailedDiagnostic, DiagnosticBag, ok, type Result } from '@uapkg/diagnostics';
import { extract as tarExtract } from 'tar';

/**
 * Extracts a downloaded .tgz into its target install path atomically.
 *
 * Strategy:
 *  1. Extract to a sibling temp directory.
 *  2. Remove the existing target (if any — safety policies already gated).
 *  3. Atomic `rename` tempDir → targetDir.
 *
 * The archive is expected to use the `<name>-<version>/` top-level directory
 * that `@uapkg/pack` emits; we strip one path component during extraction.
 */
export class PackageExtractor {
  async extract(
    packageName: string,
    tgzPath: string,
    manifestRoot: string,
    installPath: InstallPath,
  ): Promise<Result<void>> {
    const bag = new DiagnosticBag();
    const targetAbs = resolve(manifestRoot, installPath);
    const parentDir = dirname(targetAbs);
    let tempDir: string | undefined;

    try {
      await mkdir(parentDir, { recursive: true });
      tempDir = await mkdtemp(join(parentDir, '.uapkg-extract-'));
      await tarExtract({ file: tgzPath, cwd: tempDir, strip: 1 });

      await rm(targetAbs, { recursive: true, force: true });
      await rename(tempDir, targetAbs);

      return ok(undefined);
    } catch (err) {
      bag.add(createExtractionFailedDiagnostic(packageName, installPath as unknown as string, String(err)));
      // best-effort cleanup
      if (tempDir !== undefined) await this.cleanup(tempDir);
      return bag.toFailure();
    }
  }

  private async cleanup(dir: string): Promise<void> {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
