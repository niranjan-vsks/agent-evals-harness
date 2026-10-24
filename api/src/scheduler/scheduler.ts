import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ulid } from '../common/ulid';
import { assertExperimentTransition, ExperimentStatus } from '../experiments/transitions';
import { PrismaService } from '../prisma/prisma.service';
import { erroredResult, ingest, PriceSnapshot } from '../trials/ingest';
import { ErrorClass } from '../worker-client/types';
import { WorkerClient } from '../worker-client/worker-client';
import { buildSpec, ClaimedTrial, runOnWorker, SpecBuildError, WorkerOutcome } from './dispatch';
import { isDue } from './retry-policy';
import { lockExperiment, reconcileExperiments, settleOrphan, settleTrial, SettleContext, SettleResult, TX } from './settle';
import { cancelOnWorker } from './worker-cancel';

/** Consecutive terminal errors that pause an experiment (card section 4). */
export const BREAKER_THRESHOLD = 5;

/** pg_advisory_xact_lock key for "a tick is claiming". Taken before any experiment lock, by claims only. */
const CLAIM_LOCK_KEY = 7203001;

export interface SchedulerOptions {
  /** Trials with status running in the whole database; the claim re-checks it under a lock, so concurrent ticks never exceed it. */
  maxConcurrent: number;
  tickMs: number;
  heartbeatMs: number;
  orphanCheckMs: number;
}

function intFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** A pending trial the claim may take. */
interface Candidate {
  id: string;
  experimentId: string;
  configId: string;
  experimentStatus: ExperimentStatus;
  errorClass: ErrorClass | null;
  attemptCount: number;
  endedAt: Date | null;
}

/**
 * The in-process scheduler (P3 card sections 3 to 5). Every state change is written to the database before the next
 * action, so an API restart loses only an in-flight HTTP call, which orphan recovery re-queues.
 *
 * Double dispatch is prevented by the claim statement alone (one guarded UPDATE per trial); tick() holds no in-memory
 * lock, so any number of concurrent callers are safe. The slot limit is checked inside the claim transaction under an
 * advisory lock, so it holds for concurrent callers too. The interval and kick() go through a wrapper that skips an
 * overlapping run, which only saves queries.
 *
 * LOCK ORDER, everywhere: [advisory claim lock, claims only] -> experiment row -> trial and attempt rows. Settles,
 * orphan recovery and claims all follow it, as do ExperimentsService.start, extend and cancel.
 */
@Injectable()
export class Scheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(Scheduler.name);

  /** Every timestamp the scheduler writes or compares comes from here, so tests can move time. */
  clock: () => Date = () => new Date();

  /** Read from the environment at construction; tests may change the fields afterwards. */
  readonly opts: SchedulerOptions;

  private readonly inFlightIds = new Set<string>();
  private readonly dispatches = new Set<Promise<void>>();
  /** Per-dispatch heartbeat timers, so onModuleDestroy can stop them while a worker call is still in flight. */
  private readonly beats = new Set<NodeJS.Timeout>();
  private readonly breaker = new Map<string, number>();
  private tickTimer: NodeJS.Timeout | null = null;
  private orphanTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private tickAgain = false;
  private recovering = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly worker: WorkerClient,
  ) {
    this.opts = {
      maxConcurrent: intFromEnv('MAX_CONCURRENT_TRIALS', 2),
      tickMs: intFromEnv('SCHEDULER_TICK_MS', 2000),
      heartbeatMs: intFromEnv('SCHEDULER_HEARTBEAT_MS', 30_000),
      orphanCheckMs: intFromEnv('SCHEDULER_ORPHAN_CHECK_MS', 60_000),
    };
  }

  // ------------------------------------------------------------------ lifecycle

  /** Timers run when SCHEDULER_ENABLED is 1, or when it is unset outside NODE_ENV=test. Tests drive tick() by hand. */
  static timersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCHEDULER_ENABLED === '1' || (env.SCHEDULER_ENABLED === undefined && env.NODE_ENV !== 'test');
  }

  get timersRunning(): boolean {
    return this.tickTimer !== null;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!Scheduler.timersEnabled()) return;
    await this.intervalOrphans(); // boot recovery before the first tick
    this.tickTimer = setInterval(() => void this.intervalTick(false), this.opts.tickMs);
    this.orphanTimer = setInterval(() => void this.intervalOrphans(), this.opts.orphanCheckMs);
    this.tickTimer.unref();
    this.orphanTimer.unref();
    this.log.log(
      `scheduler on: max ${this.opts.maxConcurrent} concurrent, tick ${this.opts.tickMs} ms, orphan check ${this.opts.orphanCheckMs} ms`,
    );
  }

  onModuleDestroy(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.orphanTimer) clearInterval(this.orphanTimer);
    this.tickTimer = null;
    this.orphanTimer = null;
    for (const beat of this.beats) clearInterval(beat);
    this.beats.clear();
  }

  /** Interval entry point: skips the run while the previous one is still going. A kick asks for one more pass instead. */
  async intervalTick(fromKick: boolean): Promise<void> {
    if (this.ticking) {
      if (fromKick) this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.tickAgain = false;
        await this.tick();
      } while (this.tickAgain);
    } catch (e) {
      this.log.error(`tick failed: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Interval entry point for orphan recovery; skips while the previous run is still going. */
  async intervalOrphans(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      await this.recoverOrphans();
    } catch (e) {
      this.log.error(`orphan recovery failed: ${(e as Error).message}`);
    } finally {
      this.recovering = false;
    }
  }

  /** Ask for a tick soon without waiting for the interval. Never throws. */
  kick(): void {
    setImmediate(() => {
      this.intervalTick(true).catch((e) => this.log.error(`kicked tick failed: ${(e as Error).message}`));
    });
  }

  /** Resolves when no dispatch is in flight. For tests. */
  async idle(): Promise<void> {
    while (this.dispatches.size > 0) await Promise.allSettled([...this.dispatches]);
  }

  // ------------------------------------------------------------------ claim and dispatch

  /**
   * One pass: claim up to (MAX_CONCURRENT_TRIALS - running) due trials and start their dispatches. Resolves with the
   * number claimed once they are claimed, not finished.
   */
  async tick(): Promise<number> {
    const running = await this.prisma.trial.count({ where: { status: 'running' } });
    const slots = this.opts.maxConcurrent - running;
    if (slots <= 0) return 0;

    const now = this.clock();
    let claimed = 0;
    for (const c of await this.candidates()) {
      if (claimed >= slots) break;
      if (!isDue(c.errorClass, c.attemptCount, c.endedAt, now)) continue;
      let won: ClaimedTrial | null;
      try {
        won = await this.claim(c, 'tick');
      } catch (e) {
        this.log.error(`claim of trial ${c.id} failed: ${(e as Error).message}`);
        continue;
      }
      if (!won) break; // another caller took it, or the slots are full, or the experiment was paused or cancelled meanwhile
      claimed++;
      this.launch(won, true);
    }
    return claimed;
  }

  /**
   * Claims 1 trial (any experiment status but cancelled, ignoring pause and slots) and dispatches it with no retry.
   * Resolves when the trial has settled and REJECTS when the outcome could not be stored (unlike tick, whose launches
   * only log): POST /trials/adhoc must not answer 201 for a trial that is still running.
   */
  async runNow(trialId: string): Promise<void> {
    const t = await this.prisma.trial.findUnique({
      where: { id: trialId },
      select: {
        id: true,
        experimentId: true,
        configId: true,
        errorClass: true,
        attemptCount: true,
        endedAt: true,
        experiment: { select: { status: true } },
      },
    });
    if (!t) throw new NotFoundException(`trial ${trialId} not found`);
    if (t.experiment.status === 'cancelled') throw new ConflictException(`experiment ${t.experimentId} is cancelled`);
    const won = await this.claim(
      {
        id: t.id,
        experimentId: t.experimentId,
        configId: t.configId,
        experimentStatus: t.experiment.status,
        errorClass: t.errorClass,
        attemptCount: t.attemptCount,
        endedAt: t.endedAt,
      },
      'runNow',
    );
    if (!won) throw new ConflictException(`trial ${trialId} is not pending`);
    await this.track(won, this.dispatch(won, false));
  }

  private async candidates(): Promise<Candidate[]> {
    // Queued and running experiments only (DISPATCHABLE_STATUSES); a paused one carries a pause_reason. The claim re-checks both
    // under the lock. The trial status is a parameter on purpose: the claim guard below is the only place that spells out
    // the pending predicate.
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        experimentId: string;
        configId: string;
        experimentStatus: ExperimentStatus;
        errorClass: ErrorClass | null;
        attemptCount: number;
        endedAt: Date | null;
      }[]
    >`
      SELECT t.id, t.experiment_id AS "experimentId", t.config_id AS "configId", e.status::text AS "experimentStatus",
             t.error_class::text AS "errorClass", t.attempt_count AS "attemptCount", t.ended_at AS "endedAt"
      FROM trial t
      JOIN experiment e ON e.id = t.experiment_id
      JOIN experiment_config ec ON ec.experiment_id = t.experiment_id AND ec.config_id = t.config_id
      WHERE t.status = ${'pending'}::trial_status
        AND e.status IN ('queued'::experiment_status, 'running'::experiment_status)
        AND e.pause_reason IS NULL
      ORDER BY e.created_at, t.trial_index, t.task_id, ec.position`;
    return rows.map((r) => ({ ...r, endedAt: r.endedAt ? new Date(r.endedAt) : null }));
  }

  /**
   * The double-dispatch guard (card section 5): one UPDATE per trial that only matches while the trial is pending,
   * so of any number of concurrent callers exactly 1 gets the row back. In the same transaction: the price is read
   * from the config's model now (D-7), the attempt row is written before the HTTP call (DATA_MODEL 2.8), and a queued
   * (or, for runNow, draft) experiment becomes running.
   *
   * The experiment row is locked FIRST (see the lock order above) and its status and pause_reason are checked under
   * that lock, so a cancel or a pause that committed after the candidate query is seen. A tick also takes the
   * advisory claim lock before that and re-counts the running trials, which makes the slot limit exact for concurrent
   * ticks. Resolves null when the trial, the slot or the experiment is gone.
   */
  private async claim(c: Candidate, mode: 'tick' | 'runNow'): Promise<ClaimedTrial | null> {
    const now = this.clock();
    return this.prisma.$transaction(async (tx) => {
      if (mode === 'tick') await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CLAIM_LOCK_KEY}::bigint)`;
      const e = await lockExperiment(tx, c.experimentId);
      if (!e) return null;
      const live = e.status === 'queued' || e.status === 'running';
      const dispatchable = mode === 'tick' ? live && e.pauseReason === null : e.status !== 'cancelled';
      if (!dispatchable) return null;
      if (mode === 'tick') {
        if ((await tx.trial.count({ where: { status: 'running' } })) >= this.opts.maxConcurrent) return null;
        // The candidate row is older than this lock: the trial may have been claimed, failed and requeued with a backoff since.
        // Due-ness is judged on the fresh columns; whether it is still pending is decided by the guarded UPDATE below.
        const fresh = await tx.trial.findUnique({ where: { id: c.id }, select: { errorClass: true, attemptCount: true, endedAt: true } });
        if (fresh && !isDue(fresh.errorClass, fresh.attemptCount, fresh.endedAt, now)) return null;
      }

      const config = await tx.config.findUniqueOrThrow({ where: { id: c.configId }, include: { model: true } });
      const price: PriceSnapshot = {
        input_price_per_mtok: config.model.inputPricePerMtok.toNumber(),
        output_price_per_mtok: config.model.outputPricePerMtok.toNumber(),
      };
      const rows = await tx.$queryRaw<
        { id: string; experiment_id: string; config_id: string; task_id: string; task_version_hash: string; seed: number; attempt_count: number }[]
      >`
        UPDATE trial
        SET status = 'running'::trial_status,
            attempt_count = attempt_count + 1,
            started_at = COALESCE(started_at, ${now}::timestamptz),
            ended_at = NULL,
            heartbeat_at = ${now}::timestamptz,
            error_class = NULL,
            error_message = NULL,
            price_snapshot = ${JSON.stringify(price)}::jsonb
        WHERE id = ${c.id}
          AND status = 'pending'::trial_status
        RETURNING id, experiment_id, config_id, task_id, task_version_hash, seed, attempt_count`;
      if (rows.length === 0) return null;
      const row = rows[0];

      const last = await tx.trialAttempt.aggregate({ where: { trialId: c.id }, _max: { attemptNo: true } });
      const attemptNo = (last._max.attemptNo ?? 0) + 1;
      await tx.trialAttempt.create({ data: { id: ulid(), trialId: c.id, attemptNo, startedAt: now } });

      if (e.status === 'queued' || e.status === 'draft') {
        assertExperimentTransition(e.status, 'running', e.status === 'draft' ? 'adhoc' : 'dispatch');
        await tx.$executeRaw`
          UPDATE experiment SET status = 'running'::experiment_status, started_at = COALESCE(started_at, ${now}::timestamptz)
          WHERE id = ${c.experimentId}`;
      }

      return {
        trialId: row.id,
        experimentId: row.experiment_id,
        configId: row.config_id,
        taskId: row.task_id,
        taskVersionHash: row.task_version_hash,
        seed: row.seed,
        attemptNo,
        attemptCount: row.attempt_count,
        price,
        modelSlug: config.modelSlug,
      };
    }, TX);
  }

  /** Starts a dispatch from tick(): a failure is logged and never escapes, so it cannot crash the process. */
  private launch(c: ClaimedTrial, retry: boolean): void {
    const run = this.dispatch(c, retry).catch((e) => this.log.error(`dispatch of trial ${c.trialId} failed: ${(e as Error).stack ?? e}`));
    void this.track(c, run);
  }

  /** Registers an in-flight dispatch so recoverOrphans skips it and idle() waits for it. The result settles like `run`. */
  private track(c: ClaimedTrial, run: Promise<void>): Promise<void> {
    this.inFlightIds.add(c.trialId);
    const p: Promise<void> = run.finally(() => {
      this.inFlightIds.delete(c.trialId);
      this.dispatches.delete(p);
    });
    this.dispatches.add(p);
    return p;
  }

  private async dispatch(c: ClaimedTrial, retry: boolean): Promise<void> {
    const beat = setInterval(() => void this.heartbeat(c.trialId), this.opts.heartbeatMs);
    beat.unref();
    this.beats.add(beat);
    let outcome: WorkerOutcome | null;
    try {
      outcome = await this.callWorker(c);
    } finally {
      clearInterval(beat);
      this.beats.delete(beat);
    }
    if (!outcome) return; // cancelled or recovered between the claim and the call: nothing to write
    await this.afterSettle(c.experimentId, await this.settle(c, outcome, retry));
  }

  /**
   * Spec build, worker call and ingest. EVERY exception in between (a TypeError from ingest() on a malformed TrialResult, a
   * database error in buildSpec or resolveJudgeModel, ...) becomes an errored worker_crash outcome that settles through the
   * normal retry routing, so a trial is never left `running` with an open attempt. A spec that cannot be built stays
   * config_invalid. Resolves null when the trial is no longer running, before any worker call is made.
   */
  private async callWorker(c: ClaimedTrial): Promise<WorkerOutcome | null> {
    try {
      const spec = await buildSpec(this.prisma, c);
      if (!(await this.stillRunning(c))) {
        this.log.warn(`trial ${c.trialId} attempt ${c.attemptNo} is no longer running; the worker call is skipped`);
        return null;
      }
      return await runOnWorker(this.worker, spec, c.price);
    } catch (e) {
      if (e instanceof SpecBuildError) return { ingested: ingest(erroredResult('config_invalid', e.message), c.price) };
      const message = e instanceof Error ? e.message : String(e);
      this.log.error(`dispatch of trial ${c.trialId} failed: ${message}`);
      return { ingested: ingest(erroredResult('worker_crash', `dispatch failed: ${message}`), c.price) };
    }
  }

  /** Guarded read just before the worker call: a cancel (or a recovery) that committed after the claim is seen here. */
  private async stillRunning(c: ClaimedTrial): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM trial t
      WHERE t.id = ${c.trialId} AND t.status = 'running'::trial_status
        AND EXISTS (SELECT 1 FROM trial_attempt a WHERE a.trial_id = t.id AND a.attempt_no = ${c.attemptNo} AND a.result IS NULL)`;
    return rows.length > 0;
  }

  private settleContext(c: ClaimedTrial, retry: boolean, maxAttempts?: number): SettleContext {
    return {
      trialId: c.trialId,
      experimentId: c.experimentId,
      attemptNo: c.attemptNo,
      modelSlug: c.modelSlug,
      now: this.clock(),
      retry,
      maxAttempts,
    };
  }

  /**
   * Stores the outcome. When that fails (a deadlock victim, a transaction timeout, a unique violation on the grader
   * rows, ...) the trial is settled once as errored worker_crash through the normal retry routing, so it does not sit
   * `running` until orphan recovery pays for a second run. If that also fails the original error goes to the caller.
   */
  private async settle(c: ClaimedTrial, outcome: WorkerOutcome, retry: boolean): Promise<SettleResult> {
    try {
      return await settleTrial(this.prisma, this.settleContext(c, retry, outcome.maxAttempts), outcome.ingested);
    } catch (e) {
      this.log.error(`could not store the result of trial ${c.trialId}: ${(e as Error).message}`);
      const message = `could not store the worker result: ${(e as Error).message}`;
      try {
        return await settleTrial(this.prisma, this.settleContext(c, retry), ingest(erroredResult('worker_crash', message), c.price));
      } catch (e2) {
        this.log.error(`could not settle trial ${c.trialId} as errored either: ${(e2 as Error).message}`);
        throw e;
      }
    }
  }

  private async heartbeat(trialId: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE trial SET heartbeat_at = ${this.clock()}::timestamptz WHERE id = ${trialId} AND status = 'running'::trial_status`;
    } catch (e) {
      this.log.warn(`heartbeat of trial ${trialId} failed: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ circuit breaker

  private async afterSettle(experimentId: string, r: SettleResult): Promise<void> {
    if (r.kind === 'done') {
      this.breaker.set(experimentId, 0);
    } else if (r.kind === 'errored') {
      const n = (this.breaker.get(experimentId) ?? 0) + 1;
      this.breaker.set(experimentId, n);
      if (n >= BREAKER_THRESHOLD) await this.pause(experimentId, r);
    }
    if (r.kind !== 'dropped' && this.timersRunning) this.kick(); // fill the free slot without waiting for the interval
  }

  private async pause(experimentId: string, last: { errorClass: ErrorClass; message: string }): Promise<void> {
    const reason = `circuit breaker: ${BREAKER_THRESHOLD} consecutive terminal errors (last: ${last.errorClass}: ${last.message.slice(0, 200)})`;
    // Only a live experiment can be paused: the 5th error may also be the last trial, which has made it partial already.
    const changed = await this.prisma.$executeRaw`
      UPDATE experiment SET pause_reason = ${reason}
      WHERE id = ${experimentId} AND pause_reason IS NULL AND status IN ('queued'::experiment_status, 'running'::experiment_status)`;
    if (changed > 0) this.log.warn(`experiment ${experimentId} paused: ${reason}`);
  }

  /** Forget the consecutive-error count of an experiment (POST /experiments/:id/resume, and extend when it reopens one). */
  resetBreaker(experimentId: string): void {
    this.breaker.delete(experimentId);
  }

  // ------------------------------------------------------------------ orphans and cancel

  /**
   * Running trials whose heartbeat is older than timeout_seconds + 180 s become pending (or errored when out of
   * attempts). Returns how many.
   *
   * By design, after an API restart the trials that were running keep a fresh heartbeat, so they stay `running` and
   * hold their slots until it ages out (up to timeout_seconds + 180 s plus the 60 s check interval). The worker may
   * still be running them, and re-dispatching at once would pay for a duplicate run; waiting is the cheaper mistake.
   */
  async recoverOrphans(): Promise<number> {
    const now = this.clock();
    const running = await this.prisma.trial.findMany({
      where: { status: 'running' },
      select: { id: true, experimentId: true, heartbeatAt: true, config: { select: { settings: true } } },
    });
    let recovered = 0;
    const settled: string[] = [];
    for (const t of running) {
      if (this.inFlightIds.has(t.id) || !t.heartbeatAt) continue;
      const timeout = Number((t.config.settings as { timeout_seconds?: number }).timeout_seconds ?? 300);
      const staleBefore = new Date(now.getTime() - (timeout + 180) * 1000);
      if (t.heartbeatAt >= staleBefore) continue;
      try {
        const r = await settleOrphan(this.prisma, t.id, staleBefore, now);
        if (r.kind === 'dropped') continue;
        recovered++;
        settled.push(t.id);
        await this.afterSettle(t.experimentId, r);
        this.log.warn(`recovered orphan trial ${t.id}: ${r.kind}`);
      } catch (e) {
        this.log.error(`could not recover trial ${t.id}: ${(e as Error).message}`);
      }
    }
    await reconcileExperiments(this.prisma, now);
    // The call that went stale may still be running on the worker (a slow provider, not a dead one): tell it to stop, so it
    // neither burns tokens nor finishes into a trial that has been re-queued. Best effort, after the transactions.
    if (settled.length > 0) {
      try {
        await this.cancelOnWorker(settled);
      } catch (e) {
        this.log.warn(`could not cancel recovered trials on the worker: ${(e as Error).message}`);
      }
    }
    return recovered;
  }

  /** Best effort DELETE /trials/{id} on the worker for each id. Never throws. */
  async cancelOnWorker(trialIds: string[]): Promise<void> {
    await cancelOnWorker(trialIds);
  }
}
