import { ErrorClass } from '../worker-client/types';
import { decideRetry, isDue, MAX_BACKPRESSURE_REQUEUES, MAX_TRIAL_ATTEMPTS, retryDueAt } from './retry-policy';

describe('decideRetry (P3 card section 4)', () => {
  it.each(['rate_limited', 'provider_error', 'worker_crash', 'orphaned'] as ErrorClass[])('%s retries twice with 30 s then 60 s, then gives up', (cls) => {
    expect(decideRetry(cls, 1)).toEqual({ retry: true, backoffMs: 30_000, countsAsAttempt: true });
    expect(decideRetry(cls, 2)).toEqual({ retry: true, backoffMs: 60_000, countsAsAttempt: true });
    expect(decideRetry(cls, 3).retry).toBe(false);
    expect(decideRetry(cls, MAX_TRIAL_ATTEMPTS + 4).retry).toBe(false);
  });

  it('grader_error is retried once, after 10 s', () => {
    expect(decideRetry('grader_error', 1)).toEqual({ retry: true, backoffMs: 10_000, countsAsAttempt: true });
    expect(decideRetry('grader_error', 2).retry).toBe(false);
  });

  it('backpressure is always retried after 5 s and does not count as an attempt', () => {
    expect(decideRetry('backpressure', 1)).toEqual({ retry: true, backoffMs: 5_000, countsAsAttempt: false });
    expect(decideRetry('backpressure', 3).retry).toBe(true);
  });

  it('a worker that answers 429 forever is eventually an error, not an endless loop', () => {
    expect(decideRetry('backpressure', 1, { backpressureRequeues: MAX_BACKPRESSURE_REQUEUES - 1 }).retry).toBe(true);
    expect(decideRetry('backpressure', 1, { backpressureRequeues: MAX_BACKPRESSURE_REQUEUES }).retry).toBe(false);
  });

  it.each(['config_invalid', 'cancelled'] as ErrorClass[])('%s is terminal at once', (cls) => {
    expect(decideRetry(cls, 1)).toEqual({ retry: false, backoffMs: 0, countsAsAttempt: true });
  });

  it('maxAttempts lowers the ceiling (an oversized trace is retried once)', () => {
    expect(decideRetry('worker_crash', 1, { maxAttempts: 2 }).retry).toBe(true);
    expect(decideRetry('worker_crash', 2, { maxAttempts: 2 }).retry).toBe(false);
  });

  it('every error class has a decision', () => {
    const all: ErrorClass[] = ['rate_limited', 'provider_error', 'worker_crash', 'grader_error', 'config_invalid', 'backpressure', 'orphaned', 'cancelled'];
    for (const c of all) expect(typeof decideRetry(c, 1).retry).toBe('boolean');
  });
});

describe('retryDueAt / isDue', () => {
  const ended = new Date('2026-01-01T00:00:00Z');

  it('a trial that never failed is due at once', () => {
    expect(retryDueAt(null, 0, null)).toBeNull();
    expect(isDue(null, 0, null, ended)).toBe(true);
  });

  it('waits the backoff of the class from the end of the last attempt', () => {
    expect(retryDueAt('worker_crash', 1, ended)?.toISOString()).toBe('2026-01-01T00:00:30.000Z');
    expect(retryDueAt('worker_crash', 2, ended)?.toISOString()).toBe('2026-01-01T00:01:00.000Z');
    expect(retryDueAt('backpressure', 1, ended)?.toISOString()).toBe('2026-01-01T00:00:05.000Z');
    expect(isDue('rate_limited', 1, ended, new Date('2026-01-01T00:00:29.999Z'))).toBe(false);
    expect(isDue('rate_limited', 1, ended, new Date('2026-01-01T00:00:30Z'))).toBe(true);
  });
});
