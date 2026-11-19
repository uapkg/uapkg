import type { PackageVersion, VersionRange } from '@uapkg/common-schema';
import semver from 'semver';

/**
 * npm-style version selection policy.
 *
 * Rules (matching npm's resolver behavior via `semver`):
 *
 *  1. A range that does not explicitly include a prerelease tag
 *     (e.g. `^1.0.0`) will never auto-select a prerelease version.
 *  2. A range with an explicit prerelease tag (e.g. `^1.0.0-0`,
 *     `>=1.0.0-beta.1`) opts-in to prereleases via `includePrerelease`.
 *  3. If the current installed version is a prerelease and a stable
 *     version satisfies the range, the stable version wins — users
 *     should escape the prerelease channel as soon as possible.
 *  4. All other ties are broken by `semver.rcompare` (highest wins).
 *
 * This class is pure: no IO, no shared state.
 */
export class SemverSelectionPolicy {
  /**
   * Select the best matching version.
   *
   * @param candidates All versions available in the registry manifest.
   * @param range The semver range from the dependency declaration.
   * @param current The version already installed/locked, if any. Used to
   *   bias escape-from-prerelease (rule #3).
   * @returns The best matching version, or `null` if nothing satisfies.
   */
  selectBest(
    candidates: readonly PackageVersion[],
    range: VersionRange,
    current?: PackageVersion,
  ): PackageVersion | null {
    return (this.rankCandidates(candidates, [range], current)[0] as PackageVersion | undefined) ?? null;
  }

  /** List published versions that satisfy every requested range for this package, preferred version first. */
  rankCandidates(candidates: readonly string[], ranges: readonly string[], current?: string): string[] {
    const currentIsPrerelease = current !== undefined && this.isPrerelease(current);
    return candidates
      .filter((version) => ranges.every((range) => this.matches(version, range)))
      .slice()
      .sort((left, right) => {
        if (currentIsPrerelease) {
          const stablePreference = Number(this.isPrerelease(left)) - Number(this.isPrerelease(right));
          if (stablePreference !== 0) return stablePreference;
        }
        return semver.rcompare(left, right) || left.localeCompare(right, 'en');
      });
  }

  matches(version: string, range: string): boolean {
    return semver.satisfies(version, range, {
      includePrerelease: this.rangeExplicitlyOptsInToPrerelease(range),
    });
  }

  /** Does the range string itself mention a prerelease tag? */
  private rangeExplicitlyOptsInToPrerelease(range: string): boolean {
    // Heuristic identical to npm's — presence of a hyphen inside a comparator
    // signals a prerelease anchor. e.g. `^1.0.0-0`, `>=2.0.0-beta.1`.
    return /\d+\.\d+\.\d+-[0-9A-Za-z.+-]+/.test(range);
  }

  /** Is the given version string a prerelease? */
  private isPrerelease(version: string): boolean {
    const pre = semver.prerelease(version);
    return pre !== null && pre.length > 0;
  }
}
