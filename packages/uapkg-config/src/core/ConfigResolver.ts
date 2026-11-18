import type { Diagnostic } from '@uapkg/diagnostics';
import type {
  ConfigLayer,
  ConfigResolvedResult,
  ConfigTraceEntry,
  ConfigValueWithOrigin,
} from '#config/contracts/ConfigTypes.ts';
import { ConfigMerger } from '#config/merge/ConfigMerger.ts';
import { getValueByPath } from '#config/schema/pathSchema.ts';
import { ConfigSemanticValidator } from '#config/core/ConfigSemanticValidator.ts';
import { projectLauncherLayers } from '#config/core/LauncherConfigProjection.ts';

export class ConfigResolver {
  constructor(
    private readonly merger = new ConfigMerger(),
    private readonly semanticValidator = new ConfigSemanticValidator(),
  ) {}

  resolveAll(layers: ConfigLayer[]): ConfigResolvedResult {
    const projected = projectLauncherLayers(layers);
    const merged = this.merger.mergeLayers(projected.layers);
    const semanticDiagnostics = this.semanticValidator.validate(merged.value);
    return {
      value: merged.value,
      diagnostics: [...projected.diagnostics, ...merged.diagnostics, ...semanticDiagnostics],
    };
  }

  resolvePath(layers: ConfigLayer[], pathToProperty: string): { value: unknown; diagnostics: readonly Diagnostic[] } {
    const resolved = this.resolveAll(layers);
    return {
      value: getValueByPath(resolved.value, pathToProperty),
      diagnostics: resolved.diagnostics,
    };
  }

  getWithOrigin(layers: ConfigLayer[], pathToProperty: string): ConfigValueWithOrigin {
    let value: unknown = null;
    let source: ConfigLayer['source'] = 'default';
    let file: string | undefined;

    const launcherPath = pathToProperty === 'launcher' || pathToProperty.startsWith('launcher.');
    const projection = launcherPath ? projectLauncherLayers(layers) : null;
    const effectiveLayers = projection?.layers ?? layers;
    for (const [index, layer] of effectiveLayers.entries()) {
      if (
        pathToProperty === 'launcher' &&
        !Object.entries(projection?.decisions[index] ?? {}).some(
          ([property, decision]) => property.startsWith('launcher.') && decision.status === 'accepted',
        )
      )
        continue;
      const layerValue = getValueByPath(layer.values, pathToProperty);
      if (layerValue !== null) {
        value = layerValue;
        source = layer.source;
        file = layer.file;
      }
    }

    return {
      value: pathToProperty === 'launcher' ? this.resolveAll(layers).value.launcher : value,
      source,
      file,
    };
  }

  trace(layers: ConfigLayer[], pathToProperty: string): ConfigTraceEntry[] {
    const launcherPath = pathToProperty === 'launcher' || pathToProperty.startsWith('launcher.');
    const projection = launcherPath ? projectLauncherLayers(layers) : null;
    return layers.map((layer, index) => ({
      source: layer.source,
      file: layer.file,
      value: getValueByPath(layer.values, pathToProperty),
      ...(projection?.decisions[index]?.[pathToProperty] ??
        (projection?.decisions[index]?.launcher?.status === 'ignored'
          ? projection.decisions[index].launcher
          : undefined) ??
        projection?.decisions[index]?.$),
    }));
  }
}
