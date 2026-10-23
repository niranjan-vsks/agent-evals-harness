import { mulberry32, percentileBootstrap, quantileSorted } from './bootstrap';
import { cohenKappa } from './kappa';

/**
 * The expected numbers below were produced by an independent Python implementation of the same
 * algorithm (mulberry32, index = floor(rng() * n), R type 7 quantiles), not by this code.
 */
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('mulberry32', () => {
  it('matches the reference outputs for seed 1', () => {
    const rng = mulberry32(1);
    const got = [rng(), rng(), rng(), rng(), rng()];
    const want = [0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849];
    got.forEach((g, i) => expect(g).toBe(want[i]));
  });

  it('matches the reference outputs for seed 20261020', () => {
    const rng = mulberry32(20261020);
    const want = [0.264247833751142, 0.23858783044852316, 0.8627477055415511, 0.5152081535197794, 0.44330049329437315];
    want.forEach((w) => expect(rng()).toBe(w));
  });

  it('is deterministic per seed, independent per instance, and stays in [0, 1)', () => {
    const a = mulberry32(5);
    const b = mulberry32(5);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(mulberry32(6)()).not.toBe(mulberry32(5)());
  });
});

describe('quantileSorted', () => {
  it('interpolates linearly between closest ranks', () => {
    expect(quantileSorted([1, 2, 3, 4], 0)).toBe(1);
    expect(quantileSorted([1, 2, 3, 4], 1)).toBe(4);
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantileSorted([10, 20], 0.25)).toBe(12.5);
    expect(quantileSorted([7], 0.975)).toBe(7);
    expect(quantileSorted([], 0.5)).toBeNaN();
  });
});

describe('percentileBootstrap', () => {
  const values = [0.0, 0.2, 0.4, -0.2, 0.6, 0.0, 0.2, 0.8, -0.4, 0.2, 0.0, 0.4];

  it('matches the reference interval for the mean of 12 values (seed 7, 2000 resamples)', () => {
    const r = percentileBootstrap(values, mean, 2000, 7);
    expect(r.observed).toBeCloseTo(0.18333333333333335, 12);
    expect(r.ciLow).toBeCloseTo(0.0, 12);
    expect(r.ciHigh).toBeCloseTo(0.3666666666666667, 12);
    expect(r).toMatchObject({ alpha: 0.05, seed: 7, resamples: 2000, usedResamples: 2000 });
  });

  it('matches the reference interval at the design setting (10,000 resamples, seed 20261020)', () => {
    const r = percentileBootstrap(values, mean, 10000, 20261020);
    expect(r.ciLow).toBeCloseTo(0.0, 12);
    expect(r.ciHigh).toBeCloseTo(0.3666666666666667, 12);
  });

  it('matches the reference interval for a paired delta (items are [a, b] pairs)', () => {
    const pairs: [number, number][] = [[1.0, 0.0], [0.8, 0.2], [1.0, 0.4], [0.6, 0.6], [0.0, 0.0], [1.0, 0.2], [0.8, 0.8], [0.4, 0.0]]; // prettier-ignore
    const r = percentileBootstrap(pairs, (s) => mean(s.map(([a, b]) => a - b)), 5000, 99);
    expect(r.observed).toBeCloseTo(0.425, 12);
    expect(r.ciLow).toBeCloseTo(0.175, 12);
    expect(r.ciHigh).toBeCloseTo(0.675, 12);
  });

  it('is reproducible for a seed and changes with it', () => {
    const a = percentileBootstrap(values, mean, 500, 3);
    expect(percentileBootstrap(values, mean, 500, 3)).toEqual(a);
    const b = percentileBootstrap(values, mean, 500, 4);
    expect([b.ciLow, b.ciHigh]).not.toEqual([a.ciLow, a.ciHigh]);
  });

  it('gives a zero-width interval for identical items and a narrower one for more data', () => {
    const same = percentileBootstrap([0.3, 0.3, 0.3, 0.3], mean, 200, 1);
    expect(same.ciLow).toBeCloseTo(0.3, 12);
    expect(same.ciHigh).toBeCloseTo(0.3, 12);
    const wide = percentileBootstrap([0, 1, 0, 1], mean, 2000, 1);
    const narrow = percentileBootstrap([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], mean, 2000, 1);
    expect(narrow.ciHigh - narrow.ciLow).toBeLessThan(wide.ciHigh - wide.ciLow);
  });

  it('drops resamples whose statistic is undefined, and says how many it used', () => {
    const r = percentileBootstrap([1, 2, 3, 4, 5], (s) => (s[0] === 1 ? NaN : mean(s)), 400, 11);
    expect(r.usedResamples).toBeLessThan(400);
    expect(r.usedResamples).toBeGreaterThan(200);
    expect(Number.isFinite(r.ciLow) && Number.isFinite(r.ciHigh)).toBe(true);
  });

  it('refuses nothing to resample', () => {
    expect(() => percentileBootstrap([], mean, 10, 1)).toThrow('at least 1 item');
    expect(() => percentileBootstrap([1], mean, 0, 1)).toThrow('positive integer');
  });
});

describe('cohenKappa', () => {
  const rep = <T>(x: T, n: number) => Array.from({ length: n }, () => x);

  it('is 1 for perfect agreement between raters that use both labels', () => {
    const k = cohenKappa([...rep([true, true] as const, 6), ...rep([false, false] as const, 4)]);
    expect(k).toMatchObject({ n: 10, agreement: 1, kappa: 1 });
  });

  it('is the textbook 0.4 for 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no (Wikipedia, 50 proposals)', () => {
    const k = cohenKappa([...rep([true, true] as const, 20), ...rep([true, false] as const, 5), ...rep([false, true] as const, 10), ...rep([false, false] as const, 15)]);
    expect(k.agreement).toBeCloseTo(0.7, 12);
    expect(k.chanceAgreement).toBeCloseTo(0.5, 12);
    expect(k.kappa).toBeCloseTo(0.4, 12);
    expect(k.counts).toEqual({ bothTrue: 20, firstOnly: 5, secondOnly: 10, bothFalse: 15 });
  });

  it('is 0 when agreement is exactly what the marginals predict', () => {
    const k = cohenKappa([...rep([true, true] as const, 25), ...rep([true, false] as const, 25), ...rep([false, true] as const, 25), ...rep([false, false] as const, 25)]);
    expect(k.agreement).toBe(0.5);
    expect(k.kappa).toBeCloseTo(0, 12);
  });

  it('is -1 when 2 balanced raters always disagree', () => {
    const k = cohenKappa([...rep([true, false] as const, 5), ...rep([false, true] as const, 5)]);
    expect(k.agreement).toBe(0);
    expect(k.kappa).toBeCloseTo(-1, 12);
  });

  it('is symmetric in the raters', () => {
    const pairs: [boolean, boolean][] = [[true, true], [true, false], [false, false], [true, false], [false, true], [true, true]]; // prettier-ignore
    expect(cohenKappa(pairs).kappa).toBeCloseTo(cohenKappa(pairs.map(([a, b]) => [b, a] as const)).kappa as number, 12);
  });

  it('is undefined, not 1 and not 0, when both raters gave every item the same label', () => {
    expect(cohenKappa(rep([true, true] as const, 8)).kappa).toBeNull();
    expect(cohenKappa(rep([false, false] as const, 8)).kappa).toBeNull();
    expect(cohenKappa(rep([true, true] as const, 8)).agreement).toBe(1);
  });

  it('rejects an empty list', () => {
    expect(() => cohenKappa([])).toThrow('at least 1 pair');
  });

  it('has a bootstrap interval that matches the reference (30 items, kappa 0.5333)', () => {
    const items: (readonly [boolean, boolean])[] = [...rep([true, true] as const, 12), ...rep([true, false] as const, 3), ...rep([false, true] as const, 4), ...rep([false, false] as const, 11)];
    const r = percentileBootstrap(items, (s) => cohenKappa(s).kappa ?? NaN, 10000, 20261023);
    expect(r.observed).toBeCloseTo(0.5333333333333334, 12);
    expect(r.ciLow).toBeCloseTo(0.19999999999999996, 12);
    expect(r.ciHigh).toBeCloseTo(0.8, 12);
    expect(r.usedResamples).toBe(10000);
  });
});
