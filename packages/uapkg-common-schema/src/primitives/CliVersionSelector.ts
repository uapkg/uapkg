import { z } from 'zod';
import type { Brand } from '#common-schema/brand/Brand.ts';

export type CliVersionSelector = Brand<string, 'CliVersionSelector'>;

// npm semver restricts the three release components to safe integers. Build the
// portable pattern from that bound so JSON Schema consumers enforce it too.
function boundedIntegerPattern(maximum: number): string {
  const digits = String(maximum);
  const alternatives = ['0', `[1-9][0-9]{0,${digits.length - 2}}`];
  for (let index = 0; index < digits.length; index++) {
    const digit = Number(digits[index]);
    const minimum = index === 0 ? 1 : 0;
    if (digit <= minimum) continue;
    const range = digit - 1 === minimum ? String(minimum) : `[${minimum}-${digit - 1}]`;
    alternatives.push(`${digits.slice(0, index)}${range}[0-9]{${digits.length - index - 1}}`);
  }
  alternatives.push(digits);
  return `(?:${alternatives.join('|')})`;
}

const component = boundedIntegerPattern(Number.MAX_SAFE_INTEGER);
const release = `${component}\\.${component}\\.${component}`;
const build = '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
const exact = `${release}(?:-(?:alpha|beta)\\.(?:0|[1-9][0-9]*))?${build}`;
const alias = `${release}-(?:alpha|beta)`;
// The negative lookahead is a strict end anchor, including trailing newlines.
const selectorPattern = new RegExp(`^(?:latest|${exact}|${alias})(?![\\s\\S])`);

/** CLI routing selectors are separate from package versions and dependency ranges. */
export const CliVersionSelectorSchema = z
  .string()
  .max(256)
  .regex(selectorPattern, 'Expected an exact CLI version, latest, or a version-scoped alpha/beta alias')
  .brand('CliVersionSelector');
