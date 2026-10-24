/**
 * Exact two-sided binomial test against a fair coin, and the sign test over tasks built on it (DESIGN 9.5).
 * Pure; no resampling.
 */

/**
 * Two-sided exact p-value of `wins` vs `losses` under H0: each non-tied case is a fair coin flip.
 * With n = wins + losses and k = min(wins, losses), p = min(1, 2 * P(X <= k)) for X ~ Binomial(n, 1/2).
 * n = 0 gives 1. The sum is done in BigInt, so for n up to a few thousand it is exact up to the final
 * rounding of the quotient (67 / 1024 comes out as exactly 0.0654296875).
 */
export function exactBinomialTwoSidedP(wins: number, losses: number): number {
  if (!Number.isInteger(wins) || !Number.isInteger(losses) || wins < 0 || losses < 0) {
    throw new Error('wins and losses must be non-negative integers');
  }
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let coeff = 1n; // C(n, i)
  let tail = 0n; // sum_{i <= k} C(n, i)
  for (let i = 0; i <= k; i++) {
    tail += coeff;
    coeff = (coeff * BigInt(n - i)) / BigInt(i + 1);
  }
  const SCALE = 64n;
  const twice = (2n * tail << SCALE) / (1n << BigInt(n));
  const p = Number(twice) / 2 ** Number(SCALE);
  return Math.min(1, p);
}

export interface SignTestResult {
  a_wins: number;
  b_wins: number;
  ties: number;
  p_value: number;
}

/** Sign test over paired values, e.g. [rateA, rateB] per task. Ties are dropped from the test and counted. */
export function signTest(pairs: ReadonlyArray<readonly [number, number]>): SignTestResult {
  let aWins = 0;
  let bWins = 0;
  let ties = 0;
  for (const [a, b] of pairs) {
    if (a > b) aWins++;
    else if (a < b) bWins++;
    else ties++;
  }
  return { a_wins: aWins, b_wins: bWins, ties, p_value: exactBinomialTwoSidedP(aWins, bWins) };
}
