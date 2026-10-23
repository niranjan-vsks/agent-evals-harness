/** Cohen's kappa for 2 raters and 2 categories (DESIGN 8.2), pure. Symmetric in the 2 raters. */

export interface KappaResult {
  n: number;
  /** Fraction of items on which the 2 raters agree. */
  agreement: number;
  /** Agreement expected by chance from the 2 raters' own marginal rates. */
  chanceAgreement: number;
  /** (agreement - chance) / (1 - chance). null when chance agreement is 1: both raters gave 1 label to every item, so kappa is 0/0. */
  kappa: number | null;
  counts: { bothTrue: number; firstOnly: number; secondOnly: number; bothFalse: number };
}

export function cohenKappa(pairs: ReadonlyArray<readonly [boolean, boolean]>): KappaResult {
  const n = pairs.length;
  if (n === 0) throw new Error('kappa needs at least 1 pair');
  const counts = { bothTrue: 0, firstOnly: 0, secondOnly: 0, bothFalse: 0 };
  for (const [a, b] of pairs) {
    if (a && b) counts.bothTrue++;
    else if (a) counts.firstOnly++;
    else if (b) counts.secondOnly++;
    else counts.bothFalse++;
  }
  const agreement = (counts.bothTrue + counts.bothFalse) / n;
  const firstTrue = (counts.bothTrue + counts.firstOnly) / n;
  const secondTrue = (counts.bothTrue + counts.secondOnly) / n;
  const chanceAgreement = firstTrue * secondTrue + (1 - firstTrue) * (1 - secondTrue);
  const kappa = chanceAgreement === 1 ? null : (agreement - chanceAgreement) / (1 - chanceAgreement);
  return { n, agreement, chanceAgreement, kappa, counts };
}
