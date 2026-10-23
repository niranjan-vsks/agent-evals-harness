/**
 * Percentile bootstrap (DESIGN 9.3), pure. The statistic is a function of a resampled list of items,
 * so the same code serves the paired task delta (items are [rateA, rateB] pairs), cost and latency
 * (items are per-task means) and Cohen's kappa (items are [judge, human] pairs).
 */

/** mulberry32: a 32-bit seeded PRNG returning floats in [0, 1). Same outputs for the same seed on every platform. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The q-quantile (0 <= q <= 1) of an ascending list by linear interpolation between the closest
 * ranks (R type 7, the numpy default). With 10,000 resamples the 2.5 percent point is rank 249.75.
 */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export interface BootstrapResult {
  /** The statistic on the original items. NaN when it is undefined there. */
  observed: number;
  ciLow: number;
  ciHigh: number;
  alpha: number;
  seed: number;
  resamples: number;
  /** Resamples whose statistic was finite and so entered the interval; undefined ones (for example a kappa on a one-sided resample) are dropped. */
  usedResamples: number;
}

/**
 * Draws `resamples` samples of items.length items with replacement (index = floor(rng() * n), 1 rng call
 * per index, in order), applies the statistic and returns the (alpha/2, 1 - alpha/2) interval.
 */
export function percentileBootstrap<T>(
  items: readonly T[],
  statistic: (sample: T[]) => number,
  resamples: number,
  seed: number,
  alpha = 0.05,
): BootstrapResult {
  if (items.length === 0) throw new Error('bootstrap needs at least 1 item');
  if (!Number.isInteger(resamples) || resamples < 1) throw new Error('resamples must be a positive integer');
  const rng = mulberry32(seed);
  const n = items.length;
  const stats: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const sample: T[] = new Array<T>(n);
    for (let i = 0; i < n; i++) sample[i] = items[Math.floor(rng() * n)];
    const value = statistic(sample);
    if (Number.isFinite(value)) stats.push(value);
  }
  stats.sort((x, y) => x - y);
  return {
    observed: statistic([...items]),
    ciLow: quantileSorted(stats, alpha / 2),
    ciHigh: quantileSorted(stats, 1 - alpha / 2),
    alpha,
    seed,
    resamples,
    usedResamples: stats.length,
  };
}
