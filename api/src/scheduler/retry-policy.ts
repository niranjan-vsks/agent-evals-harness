/**
 * Trial-level retry policy (P3 card section 4, DESIGN 6.3), pure.
 *
 * | error_class                                        | retry                         | backoff            |
 * | rate_limited, provider_error, worker_crash, orphaned | while attempt_count < 3     | 30 s, 60 s, 120 s  |
 * | grader_error                                       | once (attempt_count < 2)      | 10 s               |
 * | backpressure                                       | always, not counted           | 5 s                |
 * | config_invalid, cancelled                          | never                         |                    |
 *
 * `attemptCount` is the number of counted attempts including the one that just failed. The 120 s step
 * is only reachable if MAX_TRIAL_ATTEMPTS is raised: 3 attempts leave room for 2 backoffs.
 */
import { ErrorClass } from '../worker-client/types';

export const MAX_TRIAL_ATTEMPTS = 3;
export const GRADER_ERROR_MAX_ATTEMPTS = 2;
export const TRANSIENT_BACKOFF_MS: readonly number[] = [30_000, 60_000, 120_000];
export const GRADER_ERROR_BACKOFF_MS = 10_000;
export const BACKPRESSURE_BACKOFF_MS = 5_000;
/** A worker that answers 429 this many times for 1 trial is not busy, it is stuck: the trial is errored. */
export const MAX_BACKPRESSURE_REQUEUES = 100;
/** Errors that end a trial on the spot, whatever the attempt count. */
export const TERMINAL_CLASSES: readonly ErrorClass[] = ['config_invalid', 'cancelled'];
/** The classes whose attempt counts against MAX_TRIAL_ATTEMPTS. */
const TRANSIENT_CLASSES: readonly ErrorClass[] = ['rate_limited', 'provider_error', 'worker_crash', 'orphaned'];

export interface RetryDecision {
  retry: boolean;
  /** Wait before the trial is dispatched again. 0 when not retrying. */
  backoffMs: number;
  /** false for backpressure: the attempt is given back, attempt_count does not move. */
  countsAsAttempt: boolean;
}

export interface RetryOptions {
  /** Lowers the attempt ceiling for a class, for example the 5 MB trace rule (DATA_MODEL 2.9: retried once). */
  maxAttempts?: number;
  /** backpressure only: how many times this trial has already been given back. */
  backpressureRequeues?: number;
}

const NO_RETRY: RetryDecision = { retry: false, backoffMs: 0, countsAsAttempt: true };

export function decideRetry(errorClass: ErrorClass, attemptCount: number, opts: RetryOptions = {}): RetryDecision {
  if (errorClass === 'backpressure') {
    if ((opts.backpressureRequeues ?? 0) >= MAX_BACKPRESSURE_REQUEUES) return NO_RETRY;
    return { retry: true, backoffMs: BACKPRESSURE_BACKOFF_MS, countsAsAttempt: false };
  }
  if (errorClass === 'grader_error') {
    const ceiling = Math.min(GRADER_ERROR_MAX_ATTEMPTS, opts.maxAttempts ?? Infinity);
    return attemptCount < ceiling ? { retry: true, backoffMs: GRADER_ERROR_BACKOFF_MS, countsAsAttempt: true } : NO_RETRY;
  }
  if (TRANSIENT_CLASSES.includes(errorClass)) {
    const ceiling = Math.min(MAX_TRIAL_ATTEMPTS, opts.maxAttempts ?? Infinity);
    if (attemptCount >= ceiling) return NO_RETRY;
    const step = Math.min(Math.max(attemptCount, 1), TRANSIENT_BACKOFF_MS.length) - 1;
    return { retry: true, backoffMs: TRANSIENT_BACKOFF_MS[step], countsAsAttempt: true };
  }
  return NO_RETRY; // config_invalid, cancelled
}

/**
 * When a trial that went back to pending may be dispatched again: the end of its last attempt plus the
 * backoff of the class it failed with. A trial that never failed (error_class null) is due at once.
 * Derived from trial columns alone, so an API restart does not shorten the wait.
 */
export function retryDueAt(
  errorClass: ErrorClass | null,
  attemptCount: number,
  endedAt: Date | null,
  opts: RetryOptions = {},
): Date | null {
  if (errorClass === null || endedAt === null) return null;
  const d = decideRetry(errorClass, Math.max(attemptCount, 1), opts);
  return new Date(endedAt.getTime() + d.backoffMs);
}

export function isDue(errorClass: ErrorClass | null, attemptCount: number, endedAt: Date | null, now: Date, opts: RetryOptions = {}): boolean {
  const due = retryDueAt(errorClass, attemptCount, endedAt, opts);
  return due === null || due.getTime() <= now.getTime();
}
