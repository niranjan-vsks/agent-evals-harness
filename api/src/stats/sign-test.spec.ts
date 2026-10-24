import { mcnemar } from './mcnemar';
import { exactBinomialTwoSidedP, signTest } from './sign-test';

/** Hand-computed: p = min(1, 2 * P(X <= min(wins, losses))) for X ~ Binomial(wins + losses, 1/2). */
describe('exactBinomialTwoSidedP', () => {
  it('9 vs 2 (n = 11, k = 2): 2 * (1 + 11 + 55) / 2048 = 0.0654296875 exactly', () => {
    expect(exactBinomialTwoSidedP(9, 2)).toBe(0.0654296875);
    expect(exactBinomialTwoSidedP(2, 9)).toBe(0.0654296875);
  });

  it('0 vs 10 is 2 / 1024, 3 vs 0 is 2 / 8, 1 vs 0 caps at 1', () => {
    expect(exactBinomialTwoSidedP(0, 10)).toBe(2 / 1024);
    expect(exactBinomialTwoSidedP(3, 0)).toBe(0.25);
    expect(exactBinomialTwoSidedP(1, 0)).toBe(1);
  });

  it('is 1 for n = 0 and is capped at 1 when the tails overlap (5 vs 5 would be 1.246)', () => {
    expect(exactBinomialTwoSidedP(0, 0)).toBe(1);
    expect(exactBinomialTwoSidedP(5, 5)).toBe(1);
    expect(exactBinomialTwoSidedP(4, 5)).toBe(1);
  });

  it('8 vs 3 (n = 11, k = 3): 2 * (1 + 11 + 55 + 165) / 2048 = 0.2265625', () => {
    expect(exactBinomialTwoSidedP(8, 3)).toBe(0.2265625);
  });

  it('stays exact for a large n (0 vs 60 is 2 / 2^60) and does not overflow for n = 2000', () => {
    expect(exactBinomialTwoSidedP(0, 60)).toBe(2 / 2 ** 60);
    expect(exactBinomialTwoSidedP(1000, 1000)).toBe(1);
    expect(exactBinomialTwoSidedP(0, 2000)).toBeLessThan(1e-18);
  });

  it('rejects counts that are not non-negative integers', () => {
    expect(() => exactBinomialTwoSidedP(-1, 3)).toThrow();
    expect(() => exactBinomialTwoSidedP(1.5, 3)).toThrow();
  });
});

describe('signTest', () => {
  it('counts 9 A wins, 2 B wins and 11 ties and gives the exact p of n = 11', () => {
    const pairs: Array<[number, number]> = [
      ...Array.from({ length: 9 }, (): [number, number] => [1, 0.5]),
      ...Array.from({ length: 2 }, (): [number, number] => [0, 0.25]),
      ...Array.from({ length: 11 }, (): [number, number] => [0.6, 0.6]),
    ];
    expect(signTest(pairs)).toEqual({ a_wins: 9, b_wins: 2, ties: 11, p_value: 0.0654296875 });
  });

  it('gives p = 1 and 0 wins for an empty list and for all ties', () => {
    expect(signTest([])).toEqual({ a_wins: 0, b_wins: 0, ties: 0, p_value: 1 });
    expect(signTest([[0.5, 0.5], [1, 1]])).toEqual({ a_wins: 0, b_wins: 0, ties: 2, p_value: 1 });
  });

  it('is symmetric in A and B', () => {
    const ab = signTest([[1, 0], [1, 0], [1, 0], [0, 1]]);
    const ba = signTest([[0, 1], [0, 1], [0, 1], [1, 0]]);
    expect(ab.p_value).toBe(ba.p_value);
    expect([ab.a_wins, ab.b_wins]).toEqual([ba.b_wins, ba.a_wins]);
    expect(ab.p_value).toBe(0.625); // n = 4, k = 1: 2 * (1 + 4) / 16
  });
});

describe('mcnemar', () => {
  const rep = <T>(x: T, n: number) => Array.from({ length: n }, () => x);

  it('9 vs 2 discordant with 11 concordant pairs: n_discordant 11, p = 0.0654296875', () => {
    const r = mcnemar([...rep([true, false] as const, 9), ...rep([false, true] as const, 2), ...rep([true, true] as const, 6), ...rep([false, false] as const, 5)]);
    expect(r).toEqual({ a_only: 9, b_only: 2, both_pass: 6, both_fail: 5, n_pairs: 22, n_discordant: 11, p_value: 0.0654296875 });
  });

  it('ignores concordant pairs entirely: the same discordant counts give the same p', () => {
    const lean = mcnemar([...rep([true, false] as const, 9), ...rep([false, true] as const, 2)]);
    const padded = mcnemar([...rep([true, false] as const, 9), ...rep([false, true] as const, 2), ...rep([true, true] as const, 40)]);
    expect(padded.p_value).toBe(lean.p_value);
  });

  it('7 vs 0 discordant is 2 / 128, and no discordant pairs gives p = 1', () => {
    expect(mcnemar(rep([true, false] as const, 7)).p_value).toBe(2 / 128);
    expect(mcnemar([[true, true], [false, false]]).p_value).toBe(1);
    expect(mcnemar([]).p_value).toBe(1);
  });
});
