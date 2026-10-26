import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { ulid } from '../common/ulid';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Scheduler } from '../scheduler/scheduler';
import { trialSeed } from '../trials/seed';
import { SettingsJson, WorkerManifest } from '../worker-client/types';
import { WorkerClient } from '../worker-client/worker-client';
import { countsFrom, TrialCounts } from './status';
import {
  assertExperimentTransition,
  canCancel,
  canExtend,
  canResume,
  canStart,
  ExperimentStatus,
  InvalidTransitionError,
} from './transitions';

const INT31 = 2 ** 31 - 1;
const TX = { timeout: 60_000, maxWait: 10_000 };
/** The most trial rows one create, start or extend may write (configs x tasks x new indices), and the largest n_trials. */
export const MAX_NEW_TRIALS = 20_000;
export const MAX_N_TRIALS = 1000;
/** Rows per createMany, so a big experiment is never materialised in memory at once. */
const CHUNK = 1000;

const Phase = z.enum(['pilot', 'full']);
const Seed = z.number().int().min(0).max(INT31);

const CreateBody = z
  .object({
    name: z.string().trim().min(1),
    config_ids: z.array(z.string().min(1)).min(2, 'an experiment compares at least 2 configs'),
    task_ids: z.array(z.string().min(1)).min(1).optional(),
    n_trials: z.number().int().min(1).max(MAX_N_TRIALS),
    seed: Seed.optional(),
    axis: z.string().min(1).optional(),
    hypothesis: z.string().min(1).optional(),
    phase: Phase.optional(),
  })
  .strict();

const ExtendBody = z.object({ n_trials: z.number().int().min(1).max(MAX_N_TRIALS), phase: Phase.optional() }).strict();
const ReproduceBody = z.object({ seed: Seed.optional() }).strict();
const TRIAL_STATUSES = ['pending', 'running', 'done', 'errored', 'cancelled'] as const;
/** Strings only: a repeated query parameter arrives as an array and must be a 400, not a Prisma error. */
const TrialsQuery = z.object({
  status: z.enum(TRIAL_STATUSES).optional(),
  config_id: z.string().optional(),
  task_id: z.string().optional(),
});

type Tx = Prisma.TransactionClient;
type Price = { input_price_per_mtok: number; output_price_per_mtok: number; cached_input_price_per_mtok: number };

function parse<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const r = schema.safeParse(raw ?? {});
  if (!r.success) {
    throw new BadRequestException({ message: `invalid ${what}`, issues: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) });
  }
  return r.data;
}

const num = (d: { toNumber(): number } | null): number | null => (d ? d.toNumber() : null);

function progressOf(c: TrialCounts) {
  return { ...c, total: c.pending + c.running + c.done + c.errored + c.cancelled };
}

type ExperimentRow = Prisma.ExperimentGetPayload<object>;

function experimentJson(e: ExperimentRow, counts: TrialCounts) {
  return {
    id: e.id,
    name: e.name,
    status: e.status,
    n_trials: e.nTrials,
    seed: e.seed,
    phase: e.phase,
    axis: e.axis,
    hypothesis: e.hypothesis,
    worker_manifest: e.workerManifest,
    created_at: e.createdAt,
    started_at: e.startedAt,
    finished_at: e.finishedAt,
    pause_reason: e.pauseReason,
    // A finished experiment cannot be resumed, so it is not "paused" even if a pause_reason is left on it.
    paused: e.pauseReason !== null && (e.status === 'queued' || e.status === 'running'),
    progress: progressOf(counts),
  };
}

function priceOf(m: { inputPricePerMtok: { toNumber(): number }; outputPricePerMtok: { toNumber(): number }; cachedInputPricePerMtok: { toNumber(): number } }): Price {
  return {
    input_price_per_mtok: m.inputPricePerMtok.toNumber(),
    output_price_per_mtok: m.outputPricePerMtok.toNumber(),
    cached_input_price_per_mtok: m.cachedInputPricePerMtok.toNumber(),
  };
}

@Injectable()
export class ExperimentsService {
  private readonly log = new Logger(ExperimentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly worker: WorkerClient,
    private readonly scheduler: Scheduler,
  ) {}

  // ------------------------------------------------------------------ create

  /**
   * POST /experiments: a draft with its configs, its tasks pinned to the CURRENT version hash (D-6) and a
   * snapshot of the worker manifest. No trials yet; start creates them.
   */
  async create(raw: unknown) {
    const body = parse(CreateBody, raw, 'experiment body');
    if (new Set(body.config_ids).size !== body.config_ids.length) throw new BadRequestException('config_ids must be distinct');
    if (body.task_ids && new Set(body.task_ids).size !== body.task_ids.length) throw new BadRequestException('task_ids must be distinct');

    const configs = await this.prisma.config.findMany({ where: { id: { in: body.config_ids } } });
    const missingConfig = body.config_ids.find((id) => !configs.some((c) => c.id === id));
    if (missingConfig) throw new NotFoundException(`config ${missingConfig} not found`);

    const tasks = await this.currentTasks(body.task_ids);
    this.assertPlan(body.config_ids.length, tasks.length, body.n_trials);
    const manifest = await this.snapshotManifest();
    const id = await this.insertDraft({
      name: body.name,
      configIds: body.config_ids,
      tasks: tasks.map((t) => ({ taskId: t.id, hash: t.versionHash })),
      nTrials: body.n_trials,
      seed: body.seed ?? randomInt(0, INT31 + 1),
      axis: body.axis ?? null,
      hypothesis: body.hypothesis ?? null,
      phase: body.phase ?? 'full',
      manifest,
    });
    return this.get(id);
  }

  private async currentTasks(taskIds: string[] | undefined) {
    if (!taskIds) {
      const all = await this.prisma.task.findMany({ where: { isCurrent: true }, orderBy: { id: 'asc' } });
      if (all.length === 0) throw new ConflictException('no task has a current version; POST /tasks/sync?');
      return all;
    }
    const rows = await this.prisma.task.findMany({ where: { id: { in: taskIds }, isCurrent: true } });
    const missing = taskIds.find((t) => !rows.some((r) => r.id === t));
    if (missing) throw new NotFoundException(`task ${missing} has no current version; POST /tasks/sync?`);
    return taskIds.map((t) => rows.find((r) => r.id === t)!);
  }

  /** An unreachable worker stores `{}`; start takes the snapshot again (the manifest is informational until then). */
  private async snapshotManifest(): Promise<unknown> {
    try {
      return await this.worker.adapters();
    } catch (e) {
      this.log.warn(`worker manifest not recorded, the worker is unreachable: ${(e as Error).message}`);
      return {};
    }
  }

  /**
   * The worker runs only the on-disk version of a task, which is the row with is_current = true (D-6). A pin to any other
   * version can never be dispatched, so start, extend and reproduce refuse it instead of queueing trials that cannot run.
   * One message per pin whose hash is not the current version of its task.
   */
  private async stalePins(db: Tx | PrismaService, pins: { taskId: string; taskVersionHash: string }[]): Promise<string[]> {
    if (pins.length === 0) return [];
    const current = await db.task.findMany({ where: { id: { in: pins.map((p) => p.taskId) }, isCurrent: true }, select: { id: true, versionHash: true } });
    const short = (h: string) => h.slice(0, 12);
    const out: string[] = [];
    for (const p of pins) {
      const now = current.find((c) => c.id === p.taskId);
      if (now?.versionHash === p.taskVersionHash) continue;
      out.push(
        now
          ? `task ${p.taskId} is pinned at ${short(p.taskVersionHash)} but the current version is ${short(now.versionHash)}; re-create the experiment`
          : `task ${p.taskId} is pinned at ${short(p.taskVersionHash)} but has no current version; re-create the experiment`,
      );
    }
    return out;
  }

  private async assertPinsRunnable(db: Tx, experimentId: string): Promise<void> {
    const pins = await db.experimentTask.findMany({ where: { experimentId }, select: { taskId: true, taskVersionHash: true }, orderBy: { taskId: 'asc' } });
    const problems = await this.stalePins(db, pins);
    if (problems.length) {
      throw new ConflictException({ message: `experiment ${experimentId} pins task versions that are not current: ${problems.join('; ')}`, problems });
    }
  }

  /** configs x tasks x new indices is the number of rows one create, start or extend writes; refuse an absurd one up front. */
  private assertSize(configs: number, tasks: number, newIndices: number): void {
    const rows = configs * tasks * newIndices;
    if (rows > MAX_NEW_TRIALS) {
      throw new BadRequestException(
        `${configs} configs x ${tasks} tasks x ${newIndices} trials = ${rows} trial rows; at most ${MAX_NEW_TRIALS} per request`,
      );
    }
  }

  /** The whole plan (configs x tasks x n_trials) is capped too, not only what one request writes: extend must not reach past it in steps. */
  private planViolation(configs: number, tasks: number, nTrials: number): string | null {
    const rows = configs * tasks * nTrials;
    return rows > MAX_NEW_TRIALS
      ? `${configs} configs x ${tasks} tasks x ${nTrials} trials = ${rows} trial rows; at most ${MAX_NEW_TRIALS} in all`
      : null;
  }

  private assertPlan(configs: number, tasks: number, nTrials: number): void {
    const violation = this.planViolation(configs, tasks, nTrials);
    if (violation) throw new BadRequestException(violation);
  }

  private async insertDraft(d: {
    name: string;
    configIds: string[];
    tasks: { taskId: string; hash: string }[];
    nTrials: number;
    seed: number;
    axis: string | null;
    hypothesis: string | null;
    phase: 'pilot' | 'full';
    manifest: unknown;
  }): Promise<string> {
    const id = ulid();
    await this.prisma.$transaction(async (tx) => {
      await tx.experiment.create({
        data: {
          id,
          name: d.name,
          status: 'draft',
          nTrials: d.nTrials,
          seed: d.seed,
          phase: d.phase,
          axis: d.axis,
          hypothesis: d.hypothesis,
          workerManifest: d.manifest as Prisma.InputJsonValue,
        },
      });
      await tx.experimentConfig.createMany({ data: d.configIds.map((configId, position) => ({ experimentId: id, configId, position })) });
      await tx.experimentTask.createMany({ data: d.tasks.map((t) => ({ experimentId: id, taskId: t.taskId, taskVersionHash: t.hash })) });
    }, TX);
    return id;
  }

  // ------------------------------------------------------------------ read

  private async counts(experimentIds: string[]): Promise<Map<string, TrialCounts>> {
    const rows = await this.prisma.trial.groupBy({ by: ['experimentId', 'status'], where: { experimentId: { in: experimentIds } }, _count: { _all: true } });
    const out = new Map<string, TrialCounts>();
    for (const id of experimentIds) out.set(id, countsFrom([]));
    for (const r of rows) {
      const c = out.get(r.experimentId)!;
      c[r.status] += r._count._all;
    }
    return out;
  }

  /** GET /experiments: newest first, with progress and without the config and task lists. */
  async list() {
    const rows = await this.prisma.experiment.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const counts = await this.counts(rows.map((r) => r.id));
    return rows.map((e) => experimentJson(e, counts.get(e.id) ?? countsFrom([])));
  }

  /** GET /experiments/:id */
  async get(id: string) {
    const e = await this.prisma.experiment.findUnique({
      where: { id },
      include: {
        configs: { include: { config: true }, orderBy: { position: 'asc' } },
        tasks: { include: { task: true }, orderBy: { taskId: 'asc' } },
      },
    });
    if (!e) throw new NotFoundException(`experiment ${id} not found`);
    const counts = (await this.counts([id])).get(id) ?? countsFrom([]);
    return {
      ...experimentJson(e, counts),
      configs: e.configs.map((c) => ({
        id: c.configId,
        name: c.config.name,
        position: c.position,
        harness_id: c.config.harnessId,
        model_slug: c.config.modelSlug,
      })),
      tasks: e.tasks.map((t) => ({ task_id: t.taskId, task_version_hash: t.taskVersionHash, category: t.task.category })),
    };
  }

  /** GET /experiments/:id/trials?status=&config_id=&task_id= */
  async trials(id: string, raw: unknown) {
    const q = parse(TrialsQuery, raw, 'trials query');
    await this.require(id);
    const rows = await this.prisma.trial.findMany({
      where: {
        experimentId: id,
        ...(q.status ? { status: q.status } : {}),
        ...(q.config_id ? { configId: q.config_id } : {}),
        ...(q.task_id ? { taskId: q.task_id } : {}),
      },
      orderBy: [{ trialIndex: 'asc' }, { taskId: 'asc' }, { configId: 'asc' }],
    });
    return rows.map((t) => ({
      id: t.id,
      experiment_id: t.experimentId,
      config_id: t.configId,
      task_id: t.taskId,
      task_version_hash: t.taskVersionHash,
      trial_index: t.trialIndex,
      seed: t.seed,
      status: t.status,
      attempt_count: t.attemptCount,
      passed: t.passed,
      exit_reason: t.exitReason,
      steps: t.steps,
      input_tokens: t.inputTokens,
      output_tokens: t.outputTokens,
      cache_read_tokens: t.cacheReadTokens,
      reasoning_tokens: t.reasoningTokens,
      api_calls: t.apiCalls,
      latency_ms: t.latencyMs,
      cost_usd: num(t.costUsd),
      harness_cost_usd: num(t.harnessCostUsd),
      price_snapshot: t.priceSnapshot,
      rate_limit_events: t.rateLimitEvents,
      error_class: t.errorClass,
      error_message: t.errorMessage,
      failure_category: t.failureCategory,
      failure_evidence: t.failureEvidence,
      started_at: t.startedAt,
      ended_at: t.endedAt,
    }));
  }

  private async require(id: string): Promise<void> {
    const found = await this.prisma.experiment.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new NotFoundException(`experiment ${id} not found`);
  }

  // ------------------------------------------------------------------ writes

  /** Row-locks the experiment for the rest of the transaction, so concurrent start, extend and cancel serialize. */
  private async lock(tx: Tx, id: string): Promise<ExperimentRow> {
    await tx.$queryRaw`SELECT id FROM experiment WHERE id = ${id} FOR UPDATE`;
    const e = await tx.experiment.findUnique({ where: { id } });
    if (!e) throw new NotFoundException(`experiment ${id} not found`);
    return e;
  }

  private conflict<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof InvalidTransitionError) throw new ConflictException(e.message);
      throw e;
    }
  }

  /**
   * Every (config, task, index) for index in [from, to), with the seed of DATA_MODEL 2.6 and the prices of today (D-7
   * placeholder), written CHUNK rows at a time.
   */
  private async createTrials(tx: Tx, e: ExperimentRow, from: number, to: number): Promise<number> {
    const [configs, tasks] = await Promise.all([
      tx.experimentConfig.findMany({
        where: { experimentId: e.id },
        include: { config: { include: { model: true } } },
        orderBy: { position: 'asc' },
      }),
      tx.experimentTask.findMany({ where: { experimentId: e.id }, orderBy: { taskId: 'asc' } }),
    ]);
    this.assertSize(configs.length, tasks.length, to - from);
    let buffer: Prisma.TrialCreateManyInput[] = [];
    let created = 0;
    const flush = async () => {
      if (buffer.length === 0) return;
      await tx.trial.createMany({ data: buffer });
      created += buffer.length;
      buffer = [];
    };
    for (let index = from; index < to; index++) {
      for (const t of tasks) {
        for (const c of configs) {
          buffer.push({
            id: ulid(),
            experimentId: e.id,
            configId: c.configId,
            taskId: t.taskId,
            taskVersionHash: t.taskVersionHash,
            trialIndex: index,
            seed: trialSeed(e.seed, c.configId, t.taskId, index),
            status: 'pending',
            attemptCount: 0,
            priceSnapshot: priceOf(c.config.model) as unknown as Prisma.InputJsonValue,
          });
          if (buffer.length >= CHUNK) await flush();
        }
      }
    }
    await flush();
    return created;
  }

  /** POST /experiments/:id/start: draft -> queued with every trial created in the same transaction (D-12). */
  async start(id: string) {
    const before = await this.prisma.experiment.findUnique({ where: { id } });
    if (!before) throw new NotFoundException(`experiment ${id} not found`);
    if (canStart(before.status) && !hasAdapters(before.workerManifest)) {
      const manifest = await this.snapshotManifest();
      if (hasAdapters(manifest)) {
        await this.prisma.experiment.updateMany({ where: { id, status: 'draft' }, data: { workerManifest: manifest as Prisma.InputJsonValue } });
      }
    }
    await this.prisma.$transaction(async (tx) => {
      const e = await this.lock(tx, id);
      this.conflict(() => {
        if (!canStart(e.status)) throw new InvalidTransitionError('experiment', e.status, 'queued', 'start');
        assertExperimentTransition(e.status, 'queued', 'start');
      });
      await this.assertPinsRunnable(tx, id);
      await this.createTrials(tx, e, 0, e.nTrials);
      await tx.experiment.update({ where: { id }, data: { status: 'queued' } });
    }, TX);
    this.scheduler.kick();
    return this.get(id);
  }

  /**
   * POST /experiments/:id/extend: raises n_trials (D-9) and creates exactly the missing indices. A draft only
   * changes its plan. completed and partial reopen as running; a pilot becomes full unless `phase` is given.
   */
  async extend(id: string, raw: unknown) {
    const body = parse(ExtendBody, raw, 'extend body');
    const reopened = await this.prisma.$transaction(async (tx) => {
      const e = await this.lock(tx, id);
      if (!canExtend(e.status)) throw new ConflictException(`experiment ${id} is ${e.status} and cannot be extended`);
      if (body.n_trials <= e.nTrials) {
        throw new ConflictException(`n_trials can only increase (D-9): ${e.nTrials} -> ${body.n_trials}`);
      }
      if (e.phase === 'full' && body.phase === 'pilot') {
        throw new ConflictException(`experiment ${id} is a full run; it cannot go back to phase pilot`);
      }
      const phase = body.phase ?? (e.phase === 'pilot' && e.status !== 'draft' ? 'full' : e.phase);
      const [configs, tasks] = await Promise.all([
        tx.experimentConfig.count({ where: { experimentId: id } }),
        tx.experimentTask.count({ where: { experimentId: id } }),
      ]);
      this.assertPlan(configs, tasks, body.n_trials); // the new total, on every status: a draft's start creates all of it
      if (e.status === 'draft') {
        await tx.experiment.update({ where: { id }, data: { nTrials: body.n_trials, phase } });
        return false;
      }
      await this.assertPinsRunnable(tx, id);
      await this.createTrials(tx, e, e.nTrials, body.n_trials);
      let status: ExperimentStatus = e.status;
      if (e.status === 'completed' || e.status === 'partial') {
        status = 'running';
        this.conflict(() => assertExperimentTransition(e.status, status, 'extend'));
      }
      const reopens = status !== e.status;
      await tx.experiment.update({
        where: { id },
        // A reopened experiment starts clean: a pause_reason left by the last run would block its dispatch for good.
        data: { nTrials: body.n_trials, phase, status, ...(reopens ? { finishedAt: null, pauseReason: null } : {}) },
      });
      return reopens;
    }, TX);
    if (reopened) this.scheduler.resetBreaker(id); // the consecutive-error count of the finished run must not carry over
    this.scheduler.kick();
    return this.get(id);
  }

  /**
   * POST /experiments/:id/cancel: pending and running trials become cancelled; the worker is told about the running ones.
   *
   * The experiment row is locked first, like every other writer of trial rows (see Scheduler: the lock order), so no
   * claim or settle is half way through when this starts and none can start until it commits. The ids of the trials that
   * were running come back from the UPDATE itself (RETURNING, with the status the row had), never from an earlier read.
   */
  async cancel(id: string) {
    const running: string[] = await this.prisma.$transaction(async (tx) => {
      const e = await this.lock(tx, id);
      if (!canCancel(e.status)) throw new ConflictException(`experiment ${id} is ${e.status} and cannot be cancelled`);
      this.conflict(() => assertExperimentTransition(e.status, 'cancelled', 'cancel'));
      const now = new Date();
      const message = 'cancelled with the experiment';
      const flipped = await tx.$queryRaw<{ id: string; was: string }[]>`
        UPDATE trial t
        SET status = 'cancelled'::trial_status, error_class = 'cancelled'::error_class, error_message = ${message},
            ended_at = ${now}::timestamptz
        FROM (
          SELECT id, status FROM trial
          WHERE experiment_id = ${id} AND status IN ('pending'::trial_status, 'running'::trial_status)
          FOR UPDATE
        ) AS prev
        WHERE t.id = prev.id
        RETURNING t.id AS id, prev.status::text AS was`;
      const runningIds = flipped.filter((r) => r.was === 'running').map((r) => r.id);
      await tx.trialAttempt.updateMany({
        where: { trialId: { in: runningIds }, result: null },
        data: { result: 'cancelled', endedAt: now, errorClass: 'cancelled', errorMessage: message },
      });
      await tx.experiment.update({ where: { id }, data: { status: 'cancelled', finishedAt: now, pauseReason: null } });
      return runningIds;
    }, TX);
    await this.scheduler.cancelOnWorker(running);
    return this.get(id);
  }

  /** POST /experiments/:id/resume: clears the circuit-breaker pause. */
  async resume(id: string) {
    const e = await this.prisma.experiment.findUnique({ where: { id } });
    if (!e) throw new NotFoundException(`experiment ${id} not found`);
    if (!canResume(e.status, e.pauseReason)) throw new ConflictException(`experiment ${id} is not paused`);
    // The count goes first: cleared after the database, a trial that errors in between would be counted on top of the
    // old 5 and re-pause the experiment at once.
    this.scheduler.resetBreaker(id);
    // The guard in the WHERE keeps 2 concurrent resumes from both succeeding.
    const r = await this.prisma.experiment.updateMany({
      where: { id, status: { in: ['queued', 'running'] }, pauseReason: { not: null } },
      data: { pauseReason: null },
    });
    if (r.count === 0) throw new ConflictException(`experiment ${id} is not paused`);
    this.scheduler.kick();
    return this.get(id);
  }

  // ------------------------------------------------------------------ reproduce

  /**
   * POST /experiments/:id/reproduce (card section 10 item 5): a new draft with the same configs, the same
   * (task, hash) pairs, n_trials, axis, hypothesis and phase, and a new seed. Refuses with the list of reasons
   * when the pinned inputs are gone or the worker is no longer the one that ran the original.
   */
  async reproduce(id: string, raw: unknown) {
    const body = parse(ReproduceBody, raw, 'reproduce body');
    const old = await this.prisma.experiment.findUnique({
      where: { id },
      include: { configs: { include: { config: true }, orderBy: { position: 'asc' } }, tasks: { orderBy: { taskId: 'asc' } } },
    });
    if (!old) throw new NotFoundException(`experiment ${id} not found`);

    const problems: string[] = [];
    const stored = await this.prisma.task.findMany({
      where: { OR: old.tasks.map((t) => ({ id: t.taskId, versionHash: t.taskVersionHash })) },
      select: { id: true, versionHash: true },
    });
    for (const t of old.tasks) {
      if (!stored.some((s) => s.id === t.taskId && s.versionHash === t.taskVersionHash)) {
        problems.push(`task ${t.taskId}@${t.taskVersionHash} is no longer stored`);
      }
    }
    // A stored pin that is no longer the current version would give a draft that start refuses.
    const storedPins = old.tasks.filter((t) => stored.some((s) => s.id === t.taskId && s.versionHash === t.taskVersionHash));
    problems.push(...(await this.stalePins(this.prisma, storedPins)));

    for (const c of old.configs) {
      const s = c.config.settings as unknown as SettingsJson;
      if (s.memory?.mode !== 'seeded') continue;
      const fixture = await this.prisma.memoryFixture.findUnique({
        where: { name_hash: { name: s.memory.fixture ?? '', hash: s.memory.fixture_hash ?? '' } },
        select: { name: true },
      });
      if (!fixture) problems.push(`memory fixture ${s.memory.fixture}@${s.memory.fixture_hash} of config ${c.configId} is no longer stored (D-5)`);
    }

    const tooBig = this.planViolation(old.configs.length, old.tasks.length, old.nTrials);
    if (tooBig) problems.push(`the plan would be refused: ${tooBig}`);

    let live: WorkerManifest | null = null;
    try {
      live = await this.worker.adapters();
    } catch (e) {
      problems.push(`the worker cannot be reached, so its harness versions cannot be compared: ${(e as Error).message}`);
    }
    const recorded = hasAdapters(old.workerManifest) ? (old.workerManifest as unknown as WorkerManifest) : null;
    if (!recorded) problems.push('the original experiment recorded no worker manifest, so its harness versions cannot be compared');
    if (live && recorded) {
      for (const harnessId of new Set(old.configs.map((c) => c.config.harnessId))) {
        const was = recorded.adapters.find((a) => a.id === harnessId)?.version;
        const now = live.adapters.find((a) => a.id === harnessId)?.version;
        if (was === undefined) problems.push(`harness ${harnessId} is not in the original worker manifest`);
        else if (now === undefined) problems.push(`harness ${harnessId} is no longer registered on the worker`);
        else if (was !== now) problems.push(`harness ${harnessId} version changed on the worker: ${was} -> ${now}`);
      }
    }
    if (problems.length) throw new ConflictException({ message: `experiment ${id} cannot be reproduced`, problems });

    const newId = await this.insertDraft({
      name: `${old.name} (reproduction)`,
      configIds: old.configs.map((c) => c.configId),
      tasks: old.tasks.map((t) => ({ taskId: t.taskId, hash: t.taskVersionHash })),
      nTrials: old.nTrials,
      seed: body.seed ?? randomInt(0, INT31 + 1),
      axis: old.axis,
      hypothesis: old.hypothesis,
      phase: old.phase,
      manifest: live,
    });
    return this.get(newId);
  }
}

function hasAdapters(manifest: unknown): boolean {
  return typeof manifest === 'object' && manifest !== null && Array.isArray((manifest as { adapters?: unknown }).adapters);
}
