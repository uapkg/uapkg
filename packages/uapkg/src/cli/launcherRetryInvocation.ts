import { CliVersionSelectorSchema } from '@uapkg/common-schema';
import { z } from 'zod';

const inlineSelector = '--cli-version=';
const tokens = z.union([
  z.tuple([z.literal('--offline')]),
  z.tuple([z.literal('--cli-version'), CliVersionSelectorSchema]),
  z.tuple([
    z
      .string()
      .refine(
        (arg) =>
          arg.startsWith(inlineSelector) &&
          CliVersionSelectorSchema.safeParse(arg.slice(inlineSelector.length)).success,
      ),
  ]),
]);
const strippedFlags = z.array(z.tuple([z.number().int().nonnegative(), tokens]));

/** Restore only validated launcher flags, in their original positions, to the displayed retry command. */
export function launcherRetryInvocation(argv: string[], raw: string | undefined): string[] {
  if (!raw) return argv;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return argv;
  }
  const parsed = strippedFlags.safeParse(value);
  if (!parsed.success) return argv;
  const separator = argv.indexOf('--');
  const limit = separator < 0 ? argv.length : separator;
  const result: string[] = [];
  let cursor = 0;
  for (const [index, args] of parsed.data) {
    if (index < cursor || index > limit) return argv;
    result.push(...argv.slice(cursor, index), ...args);
    cursor = index;
  }
  return result.concat(argv.slice(cursor));
}
