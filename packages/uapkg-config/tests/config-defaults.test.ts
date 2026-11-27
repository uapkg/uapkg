import { INTERNAL_BUILD_MODE_ENV } from '@uapkg/common';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { z } from 'zod';
import { configSchema, getDefaultConfig } from '../src/schema/configSchema.ts';
import {
  getConfigSchemaNodeKind,
  getObjectShape,
  getRecordValueSchema,
  isRecordValue,
} from '../src/schema/runtime/ConfigSchemaIntrospection.ts';

// Schema paths intentionally left without defaults; * matches any record entry.
// Each entry explains why. Exact comparison rejects stale exceptions, so remove
// an entry when a default is added.
const defaultFreePaths = {
  'registries.*.ttlSeconds': 'Inherits registryCache.ttlSeconds when omitted.',
  'registries.*.lifecyclePolicy': 'Inherits install.lifecyclePolicy when omitted.',
};

function findMissingDefaults(schema: z.ZodType, defaults: unknown, path: string[] = []): string[] {
  const kind = getConfigSchemaNodeKind(schema);
  if (kind === 'object') {
    return Object.entries(getObjectShape(schema)).flatMap(([key, child]) =>
      findMissingDefaults(child, isRecordValue(defaults) ? defaults[key] : undefined, [...path, key]),
    );
  }

  if (kind === 'record') {
    const valueSchema = getRecordValueSchema(schema);
    if (!valueSchema) throw new Error(`Missing record value schema at ${path.join('.')}`);
    const values = isRecordValue(defaults) ? Object.values(defaults) : [];
    return values.length > 0
      ? values.flatMap((value) => findMissingDefaults(valueSchema, value, [...path, '*']))
      : findMissingDefaults(valueSchema, undefined, [...path, '*']);
  }

  return defaults === undefined ? [path.join('.')] : [];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('configuration defaults', () => {
  it.each(['production', 'development'] as const)(
    'provides every schema leaf a default or a documented exception in %s builds',
    (mode) => {
      vi.stubEnv(INTERNAL_BUILD_MODE_ENV, mode);
      const defaults = getDefaultConfig();

      expect(configSchema.safeParse(defaults).success).toBe(true);
      const missingPaths = [...new Set(findMissingDefaults(configSchema, defaults))].sort();
      // Exact equality also rejects exceptions whose defaults have since been added.
      expect(missingPaths).toEqual(Object.keys(defaultFreePaths).sort());
    },
  );

  it('checks leaves inside absent optional objects and default wrappers', () => {
    const schema = z.object({
      optionalGroup: z.object({ setting: z.string().optional() }).optional(),
      defaultedGroup: z.object({ setting: z.string().optional() }).default({}),
    });

    expect(findMissingDefaults(schema, { defaultedGroup: {} })).toEqual([
      'optionalGroup.setting',
      'defaultedGroup.setting',
    ]);
  });

  it.each([
    ['empty records', {}],
    ['every record entry', { first: { setting: 'configured' }, second: {} }],
  ])('checks the value schema for %s', (_description, defaults) => {
    const schema = z.record(z.string(), z.object({ setting: z.string().optional() }));

    expect(findMissingDefaults(schema, defaults, ['entries'])).toEqual(['entries.*.setting']);
  });
});
