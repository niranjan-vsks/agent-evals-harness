/**
 * Allowed status transitions (P3 card section 4), pure.
 *
 * experiment: draft -> queued -> running -> completed | partial | cancelled
 *             completed | partial -> running   (only via extend)
 *             pause is not a status: running stays running with pause_reason set
 * trial:      pending -> running -> done | errored | pending (retry, orphan, backpressure)
 *             pending -> cancelled ; running -> cancelled
 *
 * `via` names the code path asking for the change, so "completed -> running" is legal for an extend
 * and illegal for anything else, and nothing but the derivation can write completed or partial (D-8).
 *
 * The experiment half is called by production code. The trial half (canTrialTransition, assertTrialTransition) and
 * DISPATCHABLE_STATUSES are not: trial transitions are enforced by the guarded UPDATEs in scheduler/settle.ts and
 * scheduler/scheduler.ts (WHERE status = 'pending' / 'running'), and the scheduler's candidate query spells out the
 * dispatchable experiment statuses in SQL. This table is the tested specification those statements implement.
 */
export type ExperimentStatus = 'draft' | 'queued' | 'running' | 'completed' | 'partial' | 'cancelled';
export type TrialStatus = 'pending' | 'running' | 'done' | 'errored' | 'cancelled';

export type ExperimentVia =
  | 'start' // POST /experiments/:id/start
  | 'dispatch' // the first claim of a queued experiment
  | 'adhoc' // POST /trials/adhoc claims its only trial straight from a draft
  | 'derive' // status derived from the trial counts after a trial transition
  | 'extend' // POST /experiments/:id/extend
  | 'cancel'; // POST /experiments/:id/cancel

const EXPERIMENT: Record<ExperimentVia, ReadonlyArray<readonly [ExperimentStatus, ExperimentStatus]>> = {
  start: [['draft', 'queued']],
  dispatch: [['queued', 'running']],
  adhoc: [['draft', 'running']],
  derive: [
    ['running', 'completed'],
    ['running', 'partial'],
  ],
  extend: [
    ['completed', 'running'],
    ['partial', 'running'],
  ],
  cancel: [
    ['draft', 'cancelled'],
    ['queued', 'cancelled'],
    ['running', 'cancelled'],
  ],
};

const TRIAL: Record<TrialStatus, readonly TrialStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['done', 'errored', 'pending', 'cancelled'],
  done: [],
  errored: [],
  cancelled: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly kind: 'experiment' | 'trial',
    readonly from: string,
    readonly to: string,
    readonly via?: string,
  ) {
    super(`${kind} cannot go from ${from} to ${to}${via ? ` via ${via}` : ''}`);
  }
}

/** A write that leaves the status as it is is not a transition and is always allowed. */
export function canExperimentTransition(from: ExperimentStatus, to: ExperimentStatus, via: ExperimentVia): boolean {
  if (from === to) return true;
  return EXPERIMENT[via].some(([f, t]) => f === from && t === to);
}

export function assertExperimentTransition(from: ExperimentStatus, to: ExperimentStatus, via: ExperimentVia): void {
  if (!canExperimentTransition(from, to, via)) throw new InvalidTransitionError('experiment', from, to, via);
}

export function canTrialTransition(from: TrialStatus, to: TrialStatus): boolean {
  return from === to ? false : TRIAL[from].includes(to);
}

export function assertTrialTransition(from: TrialStatus, to: TrialStatus): void {
  if (!canTrialTransition(from, to)) throw new InvalidTransitionError('trial', from, to);
}

/** Extend raises n_trials (D-9). A cancelled experiment is over; a draft only changes its plan. */
export function canExtend(status: ExperimentStatus): boolean {
  return status !== 'cancelled';
}

export function canStart(status: ExperimentStatus): boolean {
  return status === 'draft';
}

export function canCancel(status: ExperimentStatus): boolean {
  return status === 'draft' || status === 'queued' || status === 'running';
}

/** Only an experiment that is queued or running can be paused, so only it can be resumed. */
export function canResume(status: ExperimentStatus, pauseReason: string | null): boolean {
  return (status === 'queued' || status === 'running') && pauseReason !== null;
}

/** The statuses the scheduler dispatches for. A paused experiment is skipped by the pause_reason test. */
export const DISPATCHABLE_STATUSES: readonly ExperimentStatus[] = ['queued', 'running'];
