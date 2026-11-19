import { DurationStringSchema } from '@uapkg/common-schema';
import parseDuration from 'parse-duration-ms';

export const DEFAULT_PACKAGE_MINIMUM_RELEASE_AGE = '3d';

/** Returns milliseconds, or undefined if the duration is invalid or too large to convert exactly. */
export function parseReleaseAgeMilliseconds(raw: string): number | undefined {
  if (!DurationStringSchema.safeParse(raw).success) return undefined;
  const milliseconds = parseDuration(raw === '0' ? '0s' : raw);
  return milliseconds !== undefined && Number.isSafeInteger(milliseconds) && milliseconds >= 0
    ? milliseconds
    : undefined;
}
