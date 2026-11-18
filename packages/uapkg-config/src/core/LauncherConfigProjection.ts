import { createConfigInvalidValueDiagnostic, type Diagnostic } from '@uapkg/diagnostics';
import type { ConfigLayer, ConfigTraceEntry, ConfigValueWithOrigin } from '#config/contracts/ConfigTypes.ts';
import { launcherConfigSchema } from '#config/schema/configSchema.ts';
import { describeValueType, isRecordValue } from '#config/schema/runtime/ConfigSchemaIntrospection.ts';

type Decision = Pick<ConfigTraceEntry, 'status' | 'reason'>;

/** Validate each consumed override before merging; unrelated config keeps its existing policy. */
export function projectLauncherLayers(layers: readonly ConfigLayer[]): {
  layers: ConfigLayer[];
  diagnostics: Diagnostic[];
  decisions: Record<string, Decision>[];
} {
  const diagnostics: Diagnostic[] = [];
  const decisions: Record<string, Decision>[] = [];
  const origins = new Map<string, ConfigValueWithOrigin>();
  const projected = layers.map((layer) => {
    const decision: Record<string, Decision> = {};
    decisions.push(decision);
    if (layer.ignoredReason) decision.$ = { status: 'ignored', reason: layer.ignoredReason };
    if (!Object.hasOwn(layer.values, 'launcher')) return layer;
    const raw = layer.values.launcher;
    const values = { ...layer.values };
    const ignore = (property: string, expected: string, received: unknown) => {
      const retained = origins.get(property);
      const fallback = retained
        ? `; retaining ${JSON.stringify(retained.value)} from ${retained.source} config${retained.file ? ` "${retained.file}"` : ''}`
        : '; retaining earlier valid settings';
      const preview = typeof received === 'string' ? ` ${JSON.stringify(received).slice(0, 120)}` : '';
      const reason = `expected ${expected}, received ${describeValueType(received)}${preview}${fallback}`;
      decision[property] = { status: 'ignored', reason };
      diagnostics.push(
        createConfigInvalidValueDiagnostic(property, reason, {
          source: layer.source,
          filePath: layer.file,
          ignored: true,
        }),
      );
    };
    if (!isRecordValue(raw)) {
      ignore('launcher', 'an object', raw);
      delete values.launcher;
      return { ...layer, values };
    }
    const launcher = { ...raw };
    decision.launcher = { status: 'accepted' };
    for (const [key, schema] of Object.entries(launcherConfigSchema.shape)) {
      if (!Object.hasOwn(raw, key)) continue;
      const property = `launcher.${key}`;
      if (!schema.safeParse(raw[key]).success) {
        ignore(property, schema.unwrap().description ?? 'a valid value', raw[key]);
        delete launcher[key];
      } else {
        decision[property] = { status: 'accepted' };
        origins.set(property, { source: layer.source, file: layer.file, value: raw[key] });
      }
    }
    values.launcher = launcher;
    return { ...layer, values };
  });
  return { layers: projected, decisions, diagnostics };
}
