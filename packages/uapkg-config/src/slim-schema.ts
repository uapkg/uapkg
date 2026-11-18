import { z } from 'zod';
import { getDefaultConfig, partialConfigSchema } from '#config/schema/configSchema.ts';

/** Pure build-time projection: importing this module never reads user config. */
export function createSlimConfigSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(partialConfigSchema.pick({ launcher: true }), { target: 'draft-2020-12' });
  const defaults = { launcher: getDefaultConfig().launcher };
  const launcher = schema.properties?.launcher;
  if (!launcher || typeof launcher === 'boolean' || !launcher.properties) {
    throw new Error('The launcher config schema must be an object');
  }
  applyDefaults(schema, defaults);
  return schema;
}

function applyDefaults(schema: z.core.JSONSchema.BaseSchema, value: unknown): void {
  schema.default = value;
  if (!schema.properties || typeof value !== 'object' || value === null || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(schema.properties)) {
    if (typeof child === 'boolean' || !Object.hasOwn(value, key)) continue;
    applyDefaults(child, (value as Record<string, unknown>)[key]);
  }
}
