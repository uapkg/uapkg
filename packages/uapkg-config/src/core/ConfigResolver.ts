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
import { isValidatedConfigPath, projectValidatedLayers } from '#config/core/ValidatedConfigProjection.ts';
import { isRecordValue } from '#config/schema/runtime/ConfigSchemaIntrospection.ts';

export class ConfigResolver {
  constructor(
    private readonly merger = new ConfigMerger(),
    private readonly semanticValidator = new ConfigSemanticValidator(),
  ) {}

  resolveAll(layers: ConfigLayer[]): ConfigResolvedResult {
    const projected = projectValidatedLayers(layers);
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

    const projection = isValidatedConfigPath(pathToProperty) ? projectValidatedLayers(layers) : null;
    const effectiveLayers = projection?.layers ?? layers;
    const resolvedValue = projection ? getValueByPath(this.resolveAll(layers).value, pathToProperty) : null;
    const validatedObject = projection !== null && isRecordValue(resolvedValue);
    for (const [index, layer] of effectiveLayers.entries()) {
      if (
        validatedObject &&
        !Object.entries(projection?.decisions[index] ?? {}).some(
          ([property, decision]) =>
            property.startsWith(`${pathToProperty}.`) &&
            decision.status === 'accepted' &&
            !isRecordValue(getValueByPath(layer.values, property)),
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
      value: validatedObject ? resolvedValue : value,
      source,
      file,
    };
  }

  trace(layers: ConfigLayer[], pathToProperty: string): ConfigTraceEntry[] {
    const projection = isValidatedConfigPath(pathToProperty) ? projectValidatedLayers(layers) : null;
    return layers.map((layer, index) => {
      const decisions = projection?.decisions[index];
      let decision = decisions?.[pathToProperty];
      let ancestor = pathToProperty;
      while (!decision && ancestor.includes('.')) {
        ancestor = ancestor.slice(0, ancestor.lastIndexOf('.'));
        if (decisions?.[ancestor]?.status === 'ignored') decision = decisions[ancestor];
      }
      return {
        source: layer.source,
        file: layer.file,
        value: getValueByPath(layer.values, pathToProperty),
        ...(decision ?? decisions?.$),
      };
    });
  }
}
