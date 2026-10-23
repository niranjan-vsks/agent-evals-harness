import { judgePolicy, round4 } from './policy';

describe('judgePolicy (DESIGN 8.3, D-16)', () => {
  it.each([
    [1, 'trusted'],
    [0.6, 'trusted'],
    [0.5999, 'flagged'],
    [0.5, 'flagged'],
    [0.4, 'flagged'],
    [0.3999, 'excluded'],
    [0, 'excluded'],
    [-0.5, 'excluded'],
  ] as const)('kappa %p is %s', (kappa, policy) => {
    expect(judgePolicy(kappa)).toBe(policy);
  });

  it('decides on the value as stored (4 decimals), so a row never reads 0.6000 and flagged', () => {
    expect(round4(0.59996)).toBe(0.6);
    expect(judgePolicy(0.59996)).toBe('trusted');
    expect(judgePolicy(0.59994)).toBe('flagged');
    expect(judgePolicy(0.39996)).toBe('flagged');
    expect(judgePolicy(0.39994)).toBe('excluded');
  });

  it('excludes a judge with no kappa at all (D-16)', () => {
    expect(judgePolicy(null)).toBe('excluded');
    expect(judgePolicy(undefined)).toBe('excluded');
    expect(judgePolicy(NaN)).toBe('excluded');
  });
});
