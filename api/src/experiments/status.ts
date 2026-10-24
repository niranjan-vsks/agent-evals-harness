/**
 * Experiment status from trial counts (DATA_MODEL 2.6), pure. This is the only place that decides
 * `completed` or `partial`; nothing sets either by hand. D-8 is the database's last line of defence
 * (a trigger); this function never asks for `completed` while a trial is errored or cancelled.
 *
 *   running   while any trial is pending or running
 *   completed once none remain and every trial is done
 *   partial   once none remain and at least 1 trial is errored or cancelled
 *   cancelled only through the cancel endpoint, and then it stays
 *   queued    until the first trial leaves pending
 */
import { ExperimentStatus } from './transitions';

export interface TrialCounts {
  pending: number;
  running: number;
  done: number;
  errored: number;
  cancelled: number;
}

export const EMPTY_COUNTS: Readonly<TrialCounts> = { pending: 0, running: 0, done: 0, errored: 0, cancelled: 0 };

export function totalOf(c: TrialCounts): number {
  return c.pending + c.running + c.done + c.errored + c.cancelled;
}

/** Folds rows such as prisma's groupBy output into TrialCounts. */
export function countsFrom(rows: ReadonlyArray<{ status: keyof TrialCounts; count: number }>): TrialCounts {
  const out: TrialCounts = { ...EMPTY_COUNTS };
  for (const r of rows) out[r.status] += r.count;
  return out;
}

export function deriveExperimentStatus(counts: TrialCounts, current: ExperimentStatus): ExperimentStatus {
  if (current === 'cancelled' || current === 'draft') return current;
  if (totalOf(counts) === 0) return current;
  if (counts.pending + counts.running > 0) {
    const untouched = counts.running + counts.done + counts.errored + counts.cancelled === 0;
    return current === 'queued' && untouched ? 'queued' : 'running';
  }
  return counts.errored > 0 || counts.cancelled > 0 ? 'partial' : 'completed';
}
