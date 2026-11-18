import { createConfigInvalidValueDiagnostic, type Diagnostic } from '@uapkg/diagnostics';
import type { ConfigLayer, ConfigTraceEntry, ConfigValueWithOrigin } from '#config/contracts/ConfigTypes.ts';
import { launcherConfigSchema } from '#config/schema/configSchema.ts';
import {
  describeValueType,
  getConfigSchemaNodeKind,
  getObjectShape,
  isRecordValue,
  unwrapConfigSchema,
} from '#config/schema/runtime/ConfigSchemaIntrospection.ts';
import type { z } from 'zod';

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
    const project = (schema: z.ZodType, raw: unknown, property: string): { value: unknown } | null => {
      if (getConfigSchemaNodeKind(schema) === 'object') {
        if (!isRecordValue(raw)) {
          ignore(property, 'an object', raw);
          return null;
        }
        const object = { ...raw };
        decision[property] = { status: 'accepted' };
        for (const [key, child] of Object.entries(getObjectShape(schema))) {
          if (!Object.hasOwn(raw, key)) continue;
          const projected = project(child, raw[key], `${property}.${key}`);
          if (projected) object[key] = projected.value;
          else delete object[key];
        }
        return { value: object };
      }
      if (!schema.safeParse(raw).success) {
        ignore(property, unwrapConfigSchema(schema).description ?? 'a valid value', raw);
        return null;
      }
      decision[property] = { status: 'accepted' };
      origins.set(property, { source: layer.source, file: layer.file, value: raw });
      return { value: raw };
    };
    const launcher = project(launcherConfigSchema, layer.values.launcher, 'launcher');
    if (launcher) values.launcher = launcher.value;
    else delete values.launcher;
    return { ...layer, values };
  });
  return { layers: projected, decisions, diagnostics };
}
