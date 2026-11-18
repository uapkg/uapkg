import { z } from 'zod';
import type { Brand } from '#common-schema/brand/Brand.ts';

export type DurationString = Brand<string, 'DurationString'>;

// Keep this grammar portable to JSON Schema and native consumers. The strict
// end anchor rejects trailing newlines, which JavaScript's `$` would accept.
const durationPattern = /^(?:0|(?:[0-9]+w)?(?:[0-9]+d)?(?:[0-9]+h)?(?:[0-9]+m)?(?:[0-9]+s)?)(?![\s\S])/;

/** Compact, non-negative durations with fixed weeks and days. */
export const DurationStringSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(durationPattern, 'Expected 0 or a duration using w, d, h, m, s in descending order')
  .brand('DurationString');
