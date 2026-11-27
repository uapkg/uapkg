import { createUpluginMissingDiagnostic, DiagnosticBag, fail, ok, type Result } from '@uapkg/diagnostics';
import type { CollectedFile } from '#pack/contracts/PackTypes.ts';

/**
 * Verifies a plugin descriptor file exists before packing.
 */
export class PluginDescriptorGuard {
  public validate(pluginRoot: string, files: readonly CollectedFile[]): Result<void> {
    const descriptors = files.filter(
      (file) => !file.relativePath.includes('/') && file.relativePath.toLowerCase().endsWith('.uplugin'),
    );
    if (descriptors.length === 1) return ok(undefined);
    if (descriptors.length > 1) {
      return new DiagnosticBag()
        .addError(
          'PACK_DESCRIPTOR_AMBIGUOUS',
          'Expected a single .uplugin descriptor at the package root. Found ' +
            descriptors.map((file) => file.relativePath).join(', '),
          { pluginRoot },
        )
        .toFailure();
    }
    return fail([createUpluginMissingDiagnostic(pluginRoot)]);
  }
}
