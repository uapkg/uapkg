import semver from 'semver';

const versionLiteral = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const exactLiteral = new RegExp(`^(?:=\\s*)?v?(${versionLiteral})$`);
const lowerBoundLiteral = new RegExp(`(?:^|\\s)(?:\\^|~|>=)\\s*v?(${versionLiteral})(?=\\s|$)`, 'g');
const hyphenLiteral = new RegExp(`^v?(${versionLiteral})\\s+-\\s+`);

/** Read an exact version such as `1.2.3` or `=1.2.3` from a dependency declaration. */
export function exactDeclaredVersion(range: string): string | undefined {
  const literal = exactLiteral.exec(range.trim())?.[1];
  return literal && semver.valid(literal) !== null ? literal : undefined;
}

/** Return the minimum version if the range names it in full and allows it, as `^1.2.3` allows `1.2.3`. */
export function explicitMinimumVersion(range: string): string | undefined {
  if (range.includes('||')) return undefined;
  const exact = exactDeclaredVersion(range);
  if (exact) return exact;
  let minimum: semver.SemVer | null;
  try {
    minimum = semver.minVersion(range);
  } catch {
    return undefined;
  }
  if (!minimum) return undefined;
  const trimmed = range.trim();
  const literals = [...trimmed.matchAll(lowerBoundLiteral)].map((match) => match[1]!);
  const hyphen = hyphenLiteral.exec(trimmed)?.[1];
  if (hyphen) literals.push(hyphen);
  const matching = [...new Set(literals)].filter(
    (literal) => semver.valid(literal) !== null && semver.eq(literal, minimum) && semver.satisfies(literal, range),
  );
  return matching.length === 1 ? matching[0] : undefined;
}

/** Compare the cutoff in Unix seconds to avoid multiplying large registry timestamps by 1,000. */
export function releaseAgeEligible(publishedAt: number, minimumAgeMs: number, nowMs: number): boolean {
  if (minimumAgeMs === 0) return true;
  return (
    Number.isSafeInteger(publishedAt) &&
    publishedAt >= 0 &&
    Number.isSafeInteger(minimumAgeMs) &&
    minimumAgeMs >= 0 &&
    Number.isFinite(nowMs) &&
    publishedAt <= Math.floor((nowMs - minimumAgeMs) / 1000)
  );
}

export function releaseAgeRemainingSeconds(publishedAt: number, minimumAgeMs: number, nowMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.ceil(publishedAt - (nowMs - minimumAgeMs) / 1000)));
}
