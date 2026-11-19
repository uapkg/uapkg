import { describe, expect, it } from 'vite-plus/test';
import { DEFAULT_PACKAGE_MINIMUM_RELEASE_AGE, parseReleaseAgeMilliseconds } from '../src/index.ts';

describe('package minimum release age parsing', () => {
  it('shares the three-day package resolution default', () => {
    expect(DEFAULT_PACKAGE_MINIMUM_RELEASE_AGE).toBe('3d');
    expect(parseReleaseAgeMilliseconds(DEFAULT_PACKAGE_MINIMUM_RELEASE_AGE)).toBe(259_200_000);
  });

  it.each([
    ['0', 0],
    ['0s', 0],
    ['0w0d0h0m0s', 0],
    ['0003d', 259_200_000],
    ['1w2d3h4m5s', 788_645_000],
    ['90m', 5_400_000],
    ['1s', 1000],
    ['10000000w', 6_048_000_000_000_000],
    ['9007199254740s', 9_007_199_254_740_000],
    [`${'0'.repeat(63)}s`, 0],
  ] as const)('parses %s as %d milliseconds', (value, expected) => {
    expect(parseReleaseAgeMilliseconds(value)).toBe(expected);
  });

  it.each([
    '',
    '00',
    '1',
    '-1d',
    '+1d',
    '1.5h',
    '1m2h',
    '1d1d',
    '1h 30m',
    '1H',
    '1ms',
    'P3D',
    '3d\n',
    '9007199254741s',
    '9007199254740993s',
    '10000000w100000000d',
    `${'9'.repeat(63)}w`,
    `${'9'.repeat(307)}w`,
  ])('rejects unsupported or unrepresentable input %j', (value) => {
    expect(parseReleaseAgeMilliseconds(value)).toBeUndefined();
  });
});
