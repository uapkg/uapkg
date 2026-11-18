import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';
import { DurationStringSchema } from '../src/index.ts';

describe('compact duration strings', () => {
  const accepted = ['0', '0s', '0w0d0h0m0s', '3d', '1w2d3h4m5s', '30m', '90m', '1h1s', '001d', `${'1'.repeat(63)}s`];
  const rejected = [
    '',
    '1',
    '00',
    ' 3d',
    '3d ',
    '3d\n',
    '3D',
    '-1d',
    '+1d',
    '1.5h',
    '1h 2m',
    '1m2h',
    '1d2d',
    '1ms',
    '1y',
    '1mo',
    'P3D',
    `${'1'.repeat(64)}s`,
  ];

  it.each(accepted)('preserves supported duration %s', (value) => {
    expect(DurationStringSchema.parse(value)).toBe(value);
  });

  it.each(rejected)('rejects unsupported duration %j', (value) => {
    expect(DurationStringSchema.safeParse(value).success).toBe(false);
  });

  it.each([0, null, false, {}, []])('rejects non-string duration %j', (value) => {
    expect(DurationStringSchema.safeParse(value).success).toBe(false);
  });

  it('exports the same grammar through JSON Schema', () => {
    const schema = z.toJSONSchema(DurationStringSchema);
    expect(schema).toMatchObject({ type: 'string', minLength: 1, maxLength: 64 });
    for (const value of [...accepted, ...rejected]) {
      const valid = value.length >= 1 && value.length <= 64 && new RegExp(schema.pattern as string).test(value);
      expect(valid, value).toBe(DurationStringSchema.safeParse(value).success);
    }
  });
});
