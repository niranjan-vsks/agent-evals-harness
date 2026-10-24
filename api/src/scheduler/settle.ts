/**
 * The scheduler's database transitions (P3 card sections 4 and 5, brief "Scheduler"). Every function here is
 * one transaction and is guarded, so a late or duplicate outcome writes nothing:
 *
 *   settleTrial   a dispatch outcome: done, retry (back to pending), or terminal errored
 *   settleOrphan  a running trial whose heartbeat went stale
 *   refreshExperimentStatus   the only code that writes completed or partial (D-8 is the trigger behind it)
 *
 * The guard of a settle is the attempt row (`result IS NULL`) plus `trial.status = 'running'`. The attempt row
 * matters when a trial was recovered and claimed again while the first call was still in flight: the trial is
 * `running` again, but the late result belongs to an attempt that is already closed, and is dropped.
 */
import { Logger } from '@nestjs/common';
import { ulid } from '../common/ulid';
import { ExperimentStatus as PrismaExperimentStatus, Prisma } from '../generated/prisma/client';
import { countsFrom, deriveExperimentStatus } from '../experiments/status';
import { assertExperimentTransition, ExperimentStatus } from '../experiments/transitions';
import { PrismaService } from '../prisma/prisma.service';
import { ErrorClass } from '../worker-client/types';
import { IngestedTrial } from '../trials/ingest';
import { decideRetry } from './retry-policy';

const log = new Logger('Settle');

export type DbClient = PrismaService | Prisma.TransactionClient;

export interface SettleContext {
  trialId: string;
  experimentId: string;
  attemptNo: number;
  modelSlug: string;
  now: Date;
  /** false for runNow: a failure is terminal at once. */
  retry: boolean;
  /** Lowers the attempt ceiling (the oversized-trace rule retries once). */
  maxAttempts?: number;
}

export type SettleResult =
  /** The trial was cancelled or recovered meanwhile; nothing was written. */
  | { kind: 'dropped' }
  | { kind: 'done' }
  | { kind: 'errored'; errorClass: ErrorClass; message: string }
  | { kind: 'requeued'; errorClass: ErrorClass; message: string; countedAttempt: boolean };

/** Thrown inside a transaction to roll it back when the guard finds the outcome is no longer wanted. */
class Dropped extends Error {}

const D8_CODE = '23514'; // check_violation

/** Interactive transaction options shared with ExperimentsService: a big trace plus its grader rows can outlast Prisma's 5 s default. */
export const TX = { timeout: 60_000, maxWait: 10_000 };

/** The D-8 trigger raises check_violation; Prisma wraps the SQLSTATE differently per path. */
export function isD8Violation(e: unknown): boolean {
  const err = e as { code?: string; message?: string; cause?: { originalCode?: string; code?: string; message?: string } };
  const code = err?.cause?.originalCode ?? err?.cause?.code ?? err?.code;
  const text = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
  return code === D8_CODE || text.includes('D-8:');
}

/** Runs `fn`; when the D-8 trigger fires, runs it once more (a re-derive over fresh rows), then lets a second failure through. */
export async function withD8Retry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isD8Violation(e)) throw e;
    log.warn(`D-8 trigger fired; re-deriving the experiment status once: ${(e as Error).message}`);
    return fn();
  }
}

/** A transaction client has no $connect (Prisma.TransactionClient omits it); `$transaction` is not used as the marker because a spy on it leaks in. */
function isTx(db: DbClient): boolean {
  return !('$connect' in db);
}

/**
 * THE lock order of every transaction that writes a trial or attempt row: the experiment row FIRST, then trials.
 * ExperimentsService.start, extend and cancel do the same, so no 2 of them can wait on each other (40P01).
 * Returns the locked row's status and pause_reason, or null when the experiment does not exist.
 */
export async function lockExperiment(
  tx: Prisma.TransactionClient,
  experimentId: string,
): Promise<{ status: ExperimentStatus; pauseReason: string | null } | null> {
  const rows = await tx.$queryRaw<{ status: ExperimentStatus; pause_reason: string | null }[]>`
    SELECT status::text AS status, pause_reason FROM experiment WHERE id = ${experimentId} FOR UPDATE`;
  return rows.length === 0 ? null : { status: rows[0].status, pauseReason: rows[0].pause_reason };
}

async function refreshInTx(tx: Prisma.TransactionClient, experimentId: string, now: Date): Promise<ExperimentStatus> {
  const locked = await lockExperiment(tx, experimentId); // a no-op re-lock inside the settle paths, which took it first
  if (!locked) throw new Error(`experiment ${experimentId} not found`);
  const current = locked.status;
  const groups = await tx.trial.groupBy({ by: ['status'], where: { experimentId }, _count: { _all: true } });
  const next = deriveExperimentStatus(
    countsFrom(groups.map((g) => ({ status: g.status, count: g._count._all }))),
    current,
  );
  if (next === current) return current;
  assertExperimentTransition(current, next, 'derive');
  await tx.experiment.update({
    where: { id: experimentId },
    data: {
      status: next as PrismaExperimentStatus,
      finishedAt: next === 'running' ? null : now,
      // A finished experiment is over: a circuit-breaker pause left on it would be a stale flag nobody can resume (extend clears it too).
      ...(next === 'completed' || next === 'partial' ? { pauseReason: null } : {}),
    },
  });
  return next;
}

/**
 * Derives the experiment status from its trials and writes it (DATA_MODEL 2.6). Takes the row lock first, so 2
 * concurrent settles serialise and the later one sees the earlier one's commit. Given a transaction client it runs
 * inside it (the settle paths do, so trial and status commit together); given the Prisma client it opens its own.
 */
export async function refreshExperimentStatus(db: DbClient, experimentId: string, now: Date = new Date()): Promise<ExperimentStatus> {
  if (isTx(db)) return refreshInTx(db as Prisma.TransactionClient, experimentId, now);
  return withD8Retry(() => (db as PrismaService).$transaction((tx) => refreshInTx(tx, experimentId, now), TX));
}

/** Experiments marked running whose trials are all terminal: a crash between a trial commit and its status refresh. */
export async function reconcileExperiments(prisma: PrismaService, now: Date): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT e.id FROM experiment e
    WHERE e.status = 'running'::experiment_status
      AND EXISTS (SELECT 1 FROM trial t WHERE t.experiment_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM trial t WHERE t.experiment_id = e.id AND t.status IN ('pending'::trial_status, 'running'::trial_status))`;
  let n = 0;
  for (const r of rows) {
    try {
      if ((await refreshExperimentStatus(prisma, r.id, now)) !== 'running') n++;
    } catch (e) {
      log.error(`could not reconcile experiment ${r.id}: ${(e as Error).message}`);
    }
  }
  return n;
}

function jsonOrUndefined(v: unknown): Prisma.InputJsonValue | undefined {
  return v ? (v as Prisma.InputJsonValue) : undefined;
}

/** Persist the outcome of one dispatch. Copies the writes of the old synchronous settle in trials/adhoc.ts. */
export function settleTrial(prisma: PrismaService, ctx: SettleContext, r: IngestedTrial): Promise<SettleResult> {
  return withD8Retry(async () => {
    try {
      return await prisma.$transaction((tx) => settleInTx(tx, ctx, r), TX);
    } catch (e) {
      if (e instanceof Dropped) {
        log.warn(`dropped the late outcome of trial ${ctx.trialId} attempt ${ctx.attemptNo}: no longer running`);
        return { kind: 'dropped' } as SettleResult;
      }
      throw e;
    }
  });
}

async function settleInTx(tx: Prisma.TransactionClient, ctx: SettleContext, r: IngestedTrial): Promise<SettleResult> {
  const { trialId, attemptNo, now } = ctx;
  if (!(await lockExperiment(tx, ctx.experimentId))) throw new Error(`experiment ${ctx.experimentId} not found`);
  const t = await tx.trial.findUnique({ where: { id: trialId }, select: { status: true, attemptCount: true } });
  if (!t || t.status !== 'running') throw new Dropped();

  // The decision first: it picks the attempt result and the trial status. Both writes below are guarded.
  let result: SettleResult;
  if (r.status === 'done') {
    result = { kind: 'done' };
  } else {
    const errorClass = r.errorClass as ErrorClass;
    const requeues = errorClass === 'backpressure' ? await tx.trialAttempt.count({ where: { trialId, errorClass: 'backpressure' } }) : 0;
    const d = ctx.retry ? decideRetry(errorClass, t.attemptCount, { maxAttempts: ctx.maxAttempts, backpressureRequeues: requeues }) : null;
    const message = r.errorMessage ?? '';
    result = d?.retry
      ? { kind: 'requeued', errorClass, message, countedAttempt: d.countsAsAttempt }
      : { kind: 'errored', errorClass, message };
  }

  const closed = await tx.trialAttempt.updateMany({
    where: { trialId, attemptNo, result: null },
    data: {
      endedAt: now,
      result: result.kind === 'done' ? 'done' : 'errored',
      errorClass: r.errorClass,
      errorMessage: r.errorMessage,
      partialTrace: jsonOrUndefined(r.partialTrace),
    },
  });
  if (closed.count === 0) throw new Dropped();

  const guard = { id: trialId, status: 'running' as const, attemptCount: t.attemptCount };
  let moved: { count: number };
  if (result.kind === 'done') {
    moved = await tx.trial.updateMany({
      where: guard,
      data: {
        status: 'done',
        passed: r.passed,
        exitReason: r.exitReason,
        steps: r.steps,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        reasoningTokens: r.reasoningTokens,
        apiCalls: r.apiCalls,
        latencyMs: r.latencyMs,
        costUsd: r.costUsd,
        harnessCostUsd: r.harnessCostUsd,
        rateLimitEvents: r.rateLimitEvents,
        errorClass: null,
        errorMessage: null,
        endedAt: now,
      },
    });
  } else if (result.kind === 'requeued') {
    // error_class and error_message stay on the pending trial: isDue derives the backoff from them (restart-safe).
    moved = await tx.trial.updateMany({
      where: guard,
      data: {
        status: 'pending',
        errorClass: result.errorClass,
        errorMessage: result.message,
        endedAt: now,
        ...(result.countedAttempt ? {} : { attemptCount: { decrement: 1 } }),
      },
    });
  } else {
    moved = await tx.trial.updateMany({
      where: guard,
      data: {
        status: 'errored',
        passed: null,
        errorClass: result.errorClass,
        errorMessage: result.message,
        rateLimitEvents: r.rateLimitEvents,
        endedAt: now,
      },
    });
  }
  if (moved.count === 0) throw new Dropped();

  if (result.kind === 'done') {
    if (r.trace) {
      await tx.trace.create({
        data: {
          trialId,
          harnessId: r.trace.harnessId,
          harnessVersion: r.trace.harnessVersion,
          modelSlug: ctx.modelSlug,
          systemPrompt: r.trace.systemPrompt,
          events: r.trace.events as unknown as Prisma.InputJsonValue,
          memoryInitial: r.trace.memoryInitial,
          memoryFinal: r.trace.memoryFinal,
          skillsInvoked: r.trace.skillsInvoked,
          notes: r.trace.notes,
          finalResponse: r.trace.finalResponse,
        },
      });
    }
    for (const g of r.graders) {
      await tx.graderResult.create({
        data: {
          id: ulid(),
          trialId,
          graderIndex: g.grader_index,
          graderType: g.grader_type,
          passed: g.passed,
          details: g.details as Prisma.InputJsonValue,
          reasoning: g.reasoning,
          judgeModelId: g.judge_model_id,
          judgePromptHash: g.judge_prompt_hash,
          durationMs: g.duration_ms,
        },
      });
    }
  }
  await refreshExperimentStatus(tx, ctx.experimentId, now);
  return result;
}

/**
 * Recovery of one stale running trial: its open attempt becomes `orphaned`, then the same retry routing as any other
 * failure with class `orphaned`. The attempt counted already (attempt_count rose at the claim), so a trial that used
 * its 3 attempts ends errored. Guarded by status and by the heartbeat still being stale, so a trial whose dispatch is
 * alive in another process is left alone.
 */
export function settleOrphan(prisma: PrismaService, trialId: string, staleBefore: Date, now: Date): Promise<SettleResult> {
  return withD8Retry(async () => {
    try {
      return await prisma.$transaction(async (tx) => {
        // A plain read takes no row lock, so it may come before the experiment lock that must precede every trial write.
        const pre = await tx.trial.findUnique({ where: { id: trialId }, select: { experimentId: true } });
        if (!pre) throw new Dropped();
        await lockExperiment(tx, pre.experimentId);
        const t = await tx.trial.findUnique({ where: { id: trialId }, select: { status: true, attemptCount: true, heartbeatAt: true } });
        if (!t || t.status !== 'running' || !t.heartbeatAt || t.heartbeatAt >= staleBefore) throw new Dropped();
        const message = `no heartbeat since ${t.heartbeatAt.toISOString()}: the API restarted or lost the worker call`;
        const d = decideRetry('orphaned', t.attemptCount);
        const moved = await tx.trial.updateMany({
          where: { id: trialId, status: 'running', heartbeatAt: { lt: staleBefore } },
          data: { status: d.retry ? 'pending' : 'errored', errorClass: 'orphaned', errorMessage: message, endedAt: now },
        });
        if (moved.count === 0) throw new Dropped();
        await tx.trialAttempt.updateMany({
          where: { trialId, result: null },
          data: { result: 'orphaned', endedAt: now, errorClass: 'orphaned', errorMessage: message },
        });
        await refreshExperimentStatus(tx, pre.experimentId, now);
        return d.retry
          ? ({ kind: 'requeued', errorClass: 'orphaned', message, countedAttempt: true } as SettleResult)
          : ({ kind: 'errored', errorClass: 'orphaned', message } as SettleResult);
      }, TX);
    } catch (e) {
      if (e instanceof Dropped) return { kind: 'dropped' } as SettleResult;
      throw e;
    }
  });
}
