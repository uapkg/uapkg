import { describe, expect, it } from 'vite-plus/test';
import {
  exactDeclaredVersion,
  explicitMinimumVersion,
  releaseAgeEligible,
  releaseAgeRemainingSeconds,
} from '../src/resolution/ReleaseAgePolicy.ts';
import { SemverSelectionPolicy } from '../src/resolution/SemverSelectionPolicy.ts';

describe('published candidate ranking', () => {
  const policy = new SemverSelectionPolicy();

  it('intersects incoming ranges independently, including alternatives', () => {
    expect(policy.rankCandidates(['2.0.0', '1.8.0', '1.4.0'], ['^1.0.0 || ^2.0.0', '>=1.5.0 <2.0.0'])).toEqual([
      '1.8.0',
    ]);
  });

  it('preserves prerelease opt-in and stable escape ordering', () => {
    const versions = ['2.0.0-beta.1', '1.5.0', '1.4.0'];
    expect(policy.rankCandidates(versions, ['*'])).toEqual(['1.5.0', '1.4.0']);
    expect(policy.rankCandidates(versions, ['>=1.0.0-beta.1'])).toEqual(versions);
    expect(policy.rankCandidates(versions, ['>=1.0.0-beta.1'], '1.0.0-beta.1')).toEqual([
      '1.5.0',
      '1.4.0',
      '2.0.0-beta.1',
    ]);
  });

  it('breaks equal SemVer build precedence ties deterministically', () => {
    expect(policy.rankCandidates(['1.0.0+foo', '1.0.0+bar'], ['*'])).toEqual(['1.0.0+bar', '1.0.0+foo']);
  });
});

describe('explicit declaration exceptions', () => {
  it.each(['1.2.3', 'v1.2.3', '=1.2.3', '=v1.2.3'])('recognizes exact artifact %s', (range) => {
    expect(exactDeclaredVersion(range)).toBe('1.2.3');
  });

  it('retains build metadata in exact artifact identity', () => {
    expect(exactDeclaredVersion('=v1.2.3+foo')).toBe('1.2.3+foo');
  });

  it.each(['^1.2.3', '~1.2.3', '>=1.2.3 <2.0.0', '1.2.3 - 2.0.0', '>=1.0.0 >=1.2.3'])(
    'recognizes literal lower bound %s',
    (range) => {
      expect(explicitMinimumVersion(range)).toBe('1.2.3');
    },
  );

  it.each(['>1.2.3', '1.2', '1.2.x', '*', '^1.2', '>=1', '1.2.3 || 2.0.0', '<=1.2.3'])(
    'does not synthesize an exception from %s',
    (range) => {
      expect(explicitMinimumVersion(range)).toBeUndefined();
    },
  );
});

describe('release age calculated from the publication time and the current time', () => {
  it('includes the exact eligibility boundary and handles sub-day durations', () => {
    expect(releaseAgeEligible(100, 30_000, 129_999)).toBe(false);
    expect(releaseAgeEligible(100, 30_000, 130_000)).toBe(true);
    expect(releaseAgeRemainingSeconds(100, 30_000, 129_001)).toBe(1);
  });

  it('rejects future releases while enabled and disables filtering at zero', () => {
    expect(releaseAgeEligible(200, 1, 100_000)).toBe(false);
    expect(releaseAgeEligible(200, 0, 100_000)).toBe(true);
  });

  it('avoids unsafe timestamp multiplication and clamps very long waits', () => {
    expect(releaseAgeEligible(Number.MAX_SAFE_INTEGER, 1, 100_000)).toBe(false);
    expect(releaseAgeRemainingSeconds(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});
