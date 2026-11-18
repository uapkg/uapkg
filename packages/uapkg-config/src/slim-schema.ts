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
  schema.default = defaults;
  launcher.default = defaults.launcher;
  for (const [key, value] of Object.entries(defaults.launcher)) {
    const property = launcher.properties[key];
    if (property && typeof property !== 'boolean') property.default = value;
  }
  return schema;
}
