import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createManifestWriteErrorDiagnostic, DiagnosticBag, ok, type Result } from '@uapkg/diagnostics';
import { type Manifest, toDependencyRecordDeclaration } from '@uapkg/package-manifest-schema';

const MANIFEST_FILENAME = 'uapkg.json';

/**
 * Writes `uapkg.json` to a given root directory.
 */
export class ManifestWriter {
  /** Serialize and write the manifest. */
  async write(manifestRoot: string, manifest: Manifest): Promise<Result<void>> {
    const bag = new DiagnosticBag();
    const filePath = join(manifestRoot, MANIFEST_FILENAME);

    try {
      if (!existsSync(manifestRoot)) {
        await mkdir(manifestRoot, { recursive: true });
      }
      await writeFile(filePath, this.serialize(manifest), 'utf-8');
      return ok(undefined);
    } catch (err) {
      bag.add(createManifestWriteErrorDiagnostic(filePath, String(err)));
      return bag.toFailure();
    }
  }

  serialize(manifest: Manifest): string {
    return `${JSON.stringify(this.toSerializableManifest(manifest), null, 2)}\n`;
  }

  private toSerializableManifest(manifest: Manifest): Record<string, unknown> {
    const next: Record<string, unknown> = {
      ...manifest,
      dependencies: toDependencyRecordDeclaration(manifest.dependencies),
      devDependencies: toDependencyRecordDeclaration(manifest.devDependencies),
      peerDependencies: toDependencyRecordDeclaration(manifest.peerDependencies),
    };

    if (manifest.kind === 'project') {
      next.overrides = toDependencyRecordDeclaration(manifest.overrides);
    }

    return next;
  }
}
