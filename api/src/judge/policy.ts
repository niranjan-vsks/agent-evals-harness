/** Judge trust policy (DESIGN 8.3, DATA_MODEL 2.12, D-16), pure. */
export type JudgePolicy = 'trusted' | 'flagged' | 'excluded';

export const TRUSTED_KAPPA = 0.6;
export const FLAGGED_KAPPA = 0.4;

/** The precision the judge_validation columns store (numeric(6,4)). Policy is decided on the stored value. */
export function round4(x: number): number {
  return Math.round((x + Number.EPSILON) * 10000) / 10000;
}

/**
 * kappa >= 0.6 trusted; 0.4 <= kappa < 0.6 flagged; below 0.4 excluded. No kappa at all (no
 * validation row, or an undefined one) is excluded: an unvalidated judge contributes nothing to a
 * headline number (D-16). The comparison is on the value as stored, so a row never says 0.6000 and flagged.
 */
export function judgePolicy(kappa: number | null | undefined): JudgePolicy {
  if (kappa === null || kappa === undefined || !Number.isFinite(kappa)) return 'excluded';
  const stored = round4(kappa);
  if (stored >= TRUSTED_KAPPA) return 'trusted';
  if (stored >= FLAGGED_KAPPA) return 'flagged';
  return 'excluded';
}
