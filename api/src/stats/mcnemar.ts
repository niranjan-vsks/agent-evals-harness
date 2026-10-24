import { exactBinomialTwoSidedP } from './sign-test';

export interface McNemarResult {
  /** A passed, B failed. */
  a_only: number;
  /** B passed, A failed. */
  b_only: number;
  both_pass: number;
  both_fail: number;
  n_pairs: number;
  /** a_only + b_only: the only pairs that carry information. */
  n_discordant: number;
  p_value: number;
}

/**
 * Exact McNemar test (DESIGN 9.5) on 1 binary outcome per pair, [aPassed, bPassed]. Under H0 each discordant
 * pair is equally likely to favour either config, so the p-value is the exact two-sided binomial on them.
 */
export function mcnemar(pairs: ReadonlyArray<readonly [boolean, boolean]>): McNemarResult {
  let aOnly = 0;
  let bOnly = 0;
  let bothPass = 0;
  let bothFail = 0;
  for (const [a, b] of pairs) {
    if (a && b) bothPass++;
    else if (!a && !b) bothFail++;
    else if (a) aOnly++;
    else bOnly++;
  }
  return {
    a_only: aOnly,
    b_only: bOnly,
    both_pass: bothPass,
    both_fail: bothFail,
    n_pairs: pairs.length,
    n_discordant: aOnly + bOnly,
    p_value: exactBinomialTwoSidedP(aOnly, bOnly),
  };
}
