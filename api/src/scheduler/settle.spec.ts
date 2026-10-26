import { Fixtures, miniSpec, sleep, trialRowIsFree, withExperimentLock } from '../../test/helpers';
import { ulid } from '../common/ulid';
import { PrismaService } from '../prisma/prisma.service';
import { doneResult } from '../test-support/app';
import { sqlState } from '../test-support/db';
import { erroredResult, FailureTask, ingest, IngestedTrial } from '../trials/ingest';
import { ErrorClass } from '../worker-client/types';
import { MAX_BACKPRESSURE_REQUEUES } from './retry-policy';
import { isD8Violation, reconcileExperiments, refreshExperimentStatus, settleOrphan, settleTrial, SettleContext, withD8Retry } from './settle';

const PRICE = { input_price_per_mtok: 1, output_price_per_mtok: 2 };
const NOW = new Date('2030-01-01T00:00:00.000Z');
const TASK: FailureTask = { graderCount: 1, taskCategory: 'neutral_deterministic', taskFixtureDir: null, memoryMode: 'off' };

describe('settle (database)', () => {
  let prisma: PrismaService;
  let fx: Fixtures;
  let cfg: string;
  let taskN = 0;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    fx = new Fixtures(prisma);
    const base = await fx.base();
    cfg = await fx.config(base, 'c');
    await fx.tasks(['scs-01-a', 'scs-02-b', 'scs-03-c']);
  });
  afterAll(async () => {
    await fx.cleanup();
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await fx.isolate();
    taskN = 0;
  });

  /** An experiment whose trials are all claimed by hand: running, attempt_count n, 1 open attempt row n. */
  async function claimedExperiment(trialCount: number, attemptCount = 1, status: 'running' | 'queued' = 'running') {
    const taskIds = ['scs-01-a', 'scs-02-b', 'scs-03-c'].slice(0, trialCount);
    const ex = await fx.experiment({ configIds: [cfg], taskIds, status });
    const old = new Date(NOW.getTime() - 1000);
    for (const id of ex.trialIds) {
      await prisma.trial.update({ where: { id }, data: { status: 'running', attemptCount, startedAt: old, heartbeatAt: old } });
      await prisma.trialAttempt.create({ data: { id: ulid(), trialId: id, attemptNo: attemptCount, startedAt: old } });
    }
    return ex;
  }
  const ctx = (ex: { id: string; trialIds: string[] }, over: Partial<SettleContext> = {}, i = 0): SettleContext => ({
    trialId: ex.trialIds[i],
    experimentId: ex.id,
    attemptNo: 1,
    modelSlug: 'sch/slug',
    now: NOW,
    retry: true,
    ...over,
  });
  const done = (over = {}, exit: 'completed' | 'timeout' | 'max_steps' = 'completed'): IngestedTrial =>
    ingest(doneResult(miniSpec({ trial_id: `T${++taskN}` }), over, exit), PRICE, TASK);
  const errored = (cls: ErrorClass, msg = 'm', partial = null as null | { seq: number; t_ms: number; kind: string }[]): IngestedTrial =>
    ingest(erroredResult(cls, msg, partial), PRICE);
  const trial = (id: string) => prisma.trial.findUniqueOrThrow({ where: { id }, include: { attempts: { orderBy: { attemptNo: 'asc' } } } });
  const expStatus = async (id: string) => (await prisma.experiment.findUniqueOrThrow({ where: { id } })).status;

  describe('settleTrial', () => {
    it('done: trial columns, trace, grader rows and the attempt are written in one go, and a lone trial completes the experiment', async () => {
      const ex = await claimedExperiment(1);
      const r = await settleTrial(prisma, ctx(ex), done());
      expect(r).toEqual({ kind: 'done' });
      const t = await trial(ex.trialIds[0]);
      expect(t).toMatchObject({
        status: 'done',
        passed: true,
        exitReason: 'completed',
        steps: 2,
        inputTokens: 3000,
        outputTokens: 40,
        apiCalls: 2,
        latencyMs: 1234,
        errorClass: null,
      });
      expect(t.endedAt).toEqual(NOW);
      expect(Number(t.costUsd)).toBeCloseTo((3000 + 80) / 1e6, 9);
      expect(t.attempts[0]).toMatchObject({ result: 'done', errorClass: null });
      expect(t.attempts[0].endedAt).toEqual(NOW);
      const trace = await prisma.trace.findUniqueOrThrow({ where: { trialId: t.id } });
      expect(trace).toMatchObject({ modelSlug: 'sch/slug', harnessId: 'h' });
      expect((trace.events as unknown[]).length).toBe(7);
      const graders = await prisma.graderResult.findMany({ where: { trialId: t.id } });
      expect(graders).toHaveLength(1);
      expect(t.passed).toBe(graders.every((g) => g.passed)); // D-14
      const e = await prisma.experiment.findUniqueOrThrow({ where: { id: ex.id } });
      expect(e.status).toBe('completed');
      expect(e.finishedAt).toEqual(NOW);
    });

    it('a failed trial is stored with its category and evidence in the same update (the CHECK of 0003_failure_category)', async () => {
      const ex = await claimedExperiment(2);
      expect(await settleTrial(prisma, ctx(ex, {}, 0), done({}, 'max_steps'))).toEqual({ kind: 'done' });
      expect(await settleTrial(prisma, ctx(ex, {}, 1), done())).toEqual({ kind: 'done' });
      const failed = await trial(ex.trialIds[0]);
      expect(failed).toMatchObject({ status: 'done', passed: false, failureCategory: 'step_exhaustion' });
      expect(failed.failureEvidence).toMatchObject({ rule: 1, category: 'step_exhaustion' });
      const passed = await trial(ex.trialIds[1]);
      expect(passed).toMatchObject({ status: 'done', passed: true, failureCategory: null, failureEvidence: null });
    });

    it('a retryable error puts the trial back to pending, keeps error_class and message for the backoff, and stores the partial trace', async () => {
      const ex = await claimedExperiment(1);
      const partial = [{ seq: 0, t_ms: 0, kind: 'message' }];
      const r = await settleTrial(prisma, ctx(ex), errored('rate_limited', 'slow down', partial));
      expect(r).toEqual({ kind: 'requeued', errorClass: 'rate_limited', message: 'slow down', countedAttempt: true });
      const t = await trial(ex.trialIds[0]);
      expect(t).toMatchObject({ status: 'pending', errorClass: 'rate_limited', errorMessage: 'slow down', attemptCount: 1 });
      expect(t.endedAt).toEqual(NOW);
      expect(t.attempts[0]).toMatchObject({ result: 'errored', errorClass: 'rate_limited', partialTrace: partial });
      expect(await expStatus(ex.id)).toBe('running');
    });

    it('config_invalid is terminal at once; the experiment ends partial, never completed (D-8)', async () => {
      const ex = await claimedExperiment(2);
      expect(await settleTrial(prisma, ctx(ex, {}, 0), done())).toEqual({ kind: 'done' });
      expect(await expStatus(ex.id)).toBe('running');
      const r = await settleTrial(prisma, ctx(ex, {}, 1), errored('config_invalid', 'bad'));
      expect(r).toEqual({ kind: 'errored', errorClass: 'config_invalid', message: 'bad' });
      const t = await trial(ex.trialIds[1]);
      expect(t).toMatchObject({ status: 'errored', errorClass: 'config_invalid', passed: null });
      expect(await expStatus(ex.id)).toBe('partial');
    });

    it('retry disabled (runNow): a worker_crash is terminal at once', async () => {
      const ex = await claimedExperiment(1);
      const r = await settleTrial(prisma, ctx(ex, { retry: false }), errored('worker_crash'));
      expect(r.kind).toBe('errored');
      expect((await trial(ex.trialIds[0])).status).toBe('errored');
    });

    it('a transient error on the 3rd attempt is terminal, on the 2nd it is requeued', async () => {
      const ex2 = await claimedExperiment(1, 2);
      expect((await settleTrial(prisma, ctx(ex2, { attemptNo: 2 }), errored('worker_crash'))).kind).toBe('requeued');
      const ex3 = await claimedExperiment(1, 3);
      const r = await settleTrial(prisma, ctx(ex3, { attemptNo: 3 }), errored('worker_crash'));
      expect(r.kind).toBe('errored');
      const t = await trial(ex3.trialIds[0]);
      expect(t).toMatchObject({ status: 'errored', errorClass: 'worker_crash', attemptCount: 3 });
    });

    it('maxAttempts 2 (oversized trace) makes the 2nd attempt terminal', async () => {
      const ex1 = await claimedExperiment(1, 1);
      expect((await settleTrial(prisma, ctx(ex1, { maxAttempts: 2 }), errored('worker_crash'))).kind).toBe('requeued');
      const ex2 = await claimedExperiment(1, 2);
      expect((await settleTrial(prisma, ctx(ex2, { attemptNo: 2, maxAttempts: 2 }), errored('worker_crash'))).kind).toBe('errored');
    });

    it('a grader_error is retried once', async () => {
      const ex1 = await claimedExperiment(1, 1);
      expect((await settleTrial(prisma, ctx(ex1), errored('grader_error'))).kind).toBe('requeued');
      const ex2 = await claimedExperiment(1, 2);
      expect((await settleTrial(prisma, ctx(ex2, { attemptNo: 2 }), errored('grader_error'))).kind).toBe('errored');
    });

    it('backpressure gives the attempt back: attempt_count falls, the attempt row stays', async () => {
      const ex = await claimedExperiment(1, 1);
      const r = await settleTrial(prisma, ctx(ex), errored('backpressure', 'worker at capacity'));
      expect(r).toEqual({ kind: 'requeued', errorClass: 'backpressure', message: 'worker at capacity', countedAttempt: false });
      const t = await trial(ex.trialIds[0]);
      expect(t).toMatchObject({ status: 'pending', attemptCount: 0, errorClass: 'backpressure' });
      expect(t.attempts).toHaveLength(1);
      expect(t.attempts[0]).toMatchObject({ result: 'errored', errorClass: 'backpressure' });
    });

    it(`a worker that refuses ${MAX_BACKPRESSURE_REQUEUES} times is stuck, not busy: the trial errors`, async () => {
      const ex = await claimedExperiment(1, 1);
      const id = ex.trialIds[0];
      await prisma.trialAttempt.deleteMany({ where: { trialId: id } });
      await prisma.trialAttempt.createMany({
        data: Array.from({ length: MAX_BACKPRESSURE_REQUEUES }, (_, i) => ({
          id: ulid(),
          trialId: id,
          attemptNo: i + 1,
          startedAt: NOW,
          endedAt: NOW,
          result: 'errored' as const,
          errorClass: 'backpressure' as const,
        })),
      });
      await prisma.trialAttempt.create({ data: { id: ulid(), trialId: id, attemptNo: MAX_BACKPRESSURE_REQUEUES + 1, startedAt: NOW } });
      const r = await settleTrial(prisma, ctx(ex, { attemptNo: MAX_BACKPRESSURE_REQUEUES + 1 }), errored('backpressure'));
      expect(r.kind).toBe('errored');
    });

    it('drops the outcome of a trial that is no longer running and writes nothing', async () => {
      const ex = await claimedExperiment(1);
      const id = ex.trialIds[0];
      await prisma.trial.update({ where: { id }, data: { status: 'cancelled', errorClass: 'cancelled', errorMessage: 'cancelled with the experiment' } });
      await prisma.trialAttempt.updateMany({ where: { trialId: id }, data: { result: 'cancelled', endedAt: NOW } });
      expect(await settleTrial(prisma, ctx(ex), done())).toEqual({ kind: 'dropped' });
      const t = await trial(id);
      expect(t).toMatchObject({ status: 'cancelled', passed: null, errorClass: 'cancelled' });
      expect(await prisma.trace.count({ where: { trialId: id } })).toBe(0);
      expect(await prisma.graderResult.count({ where: { trialId: id } })).toBe(0);
    });

    it('drops a late result for an attempt that was already closed, even when the trial is running again (recovered and re-claimed)', async () => {
      const ex = await claimedExperiment(1, 2);
      const id = ex.trialIds[0];
      // attempt 1 was orphaned, attempt 2 is the live one
      await prisma.trialAttempt.create({
        data: { id: ulid(), trialId: id, attemptNo: 1, startedAt: NOW, endedAt: NOW, result: 'orphaned', errorClass: 'orphaned' },
      });
      expect(await settleTrial(prisma, ctx(ex, { attemptNo: 1 }), done())).toEqual({ kind: 'dropped' });
      const t = await trial(id);
      expect(t.status).toBe('running');
      expect(t.attempts.map((a) => [a.attemptNo, a.result])).toEqual([
        [1, 'orphaned'],
        [2, null],
      ]);
      expect(await prisma.trace.count({ where: { trialId: id } })).toBe(0);
    });

    it('settling twice writes once: the second outcome is dropped', async () => {
      const ex = await claimedExperiment(1);
      expect((await settleTrial(prisma, ctx(ex), done())).kind).toBe('done');
      expect(await settleTrial(prisma, ctx(ex), done())).toEqual({ kind: 'dropped' });
      expect(await prisma.graderResult.count({ where: { trialId: ex.trialIds[0] } })).toBe(1);
    });

    it('2 settles at once leave exactly 1 winner', async () => {
      const ex = await claimedExperiment(1);
      const results = await Promise.all([
        settleTrial(prisma, ctx(ex), done()),
        settleTrial(prisma, ctx(ex), done()),
        settleTrial(prisma, ctx(ex), errored('worker_crash')),
      ]);
      expect(results.filter((r) => r.kind !== 'dropped')).toHaveLength(1);
      expect((await trial(ex.trialIds[0])).attempts).toHaveLength(1);
    });

    it('the last 2 trials of an experiment settling at once still derive a final status', async () => {
      const ex = await claimedExperiment(2);
      await Promise.all([settleTrial(prisma, ctx(ex, {}, 0), done()), settleTrial(prisma, ctx(ex, {}, 1), done())]);
      expect(await expStatus(ex.id)).toBe('completed');
      const ex2 = await claimedExperiment(2);
      await Promise.all([settleTrial(prisma, ctx(ex2, {}, 0), done()), settleTrial(prisma, ctx(ex2, {}, 1), errored('config_invalid'))]);
      expect(await expStatus(ex2.id)).toBe('partial');
    });
  });

  describe('settleOrphan', () => {
    const stale = new Date(NOW.getTime() - 480_000);
    const hourAgo = new Date(NOW.getTime() - 3_600_000);
    const age = async (ex: { trialIds: string[] }) => {
      for (const id of ex.trialIds) await prisma.trial.update({ where: { id }, data: { heartbeatAt: hourAgo } });
    };

    it('a stale trial with attempts left goes back to pending with class orphaned and its attempt orphaned', async () => {
      const ex = await claimedExperiment(1);
      await age(ex);
      const r = await settleOrphan(prisma, ex.trialIds[0], stale, NOW);
      expect(r).toMatchObject({ kind: 'requeued', errorClass: 'orphaned', countedAttempt: true });
      const t = await trial(ex.trialIds[0]);
      expect(t).toMatchObject({ status: 'pending', errorClass: 'orphaned', attemptCount: 1 });
      expect(t.endedAt).toEqual(NOW);
      expect(t.attempts[0]).toMatchObject({ result: 'orphaned', errorClass: 'orphaned' });
      expect(t.attempts[0].endedAt).toEqual(NOW);
    });

    it('with 3 attempts used the trial errors and the experiment ends partial', async () => {
      const ex = await claimedExperiment(1, 3);
      await age(ex);
      const r = await settleOrphan(prisma, ex.trialIds[0], stale, NOW);
      expect(r.kind).toBe('errored');
      expect(await trial(ex.trialIds[0])).toMatchObject({ status: 'errored', errorClass: 'orphaned' });
      expect(await expStatus(ex.id)).toBe('partial');
    });

    it('leaves a trial alone whose heartbeat is newer than the cut-off, or that is not running', async () => {
      const ex = await claimedExperiment(2);
      await age(ex);
      await prisma.trial.update({ where: { id: ex.trialIds[0] }, data: { heartbeatAt: NOW } });
      expect(await settleOrphan(prisma, ex.trialIds[0], stale, NOW)).toEqual({ kind: 'dropped' });
      expect((await trial(ex.trialIds[0])).status).toBe('running');
      await prisma.trial.update({ where: { id: ex.trialIds[1] }, data: { status: 'cancelled', errorClass: 'cancelled' } });
      expect(await settleOrphan(prisma, ex.trialIds[1], stale, NOW)).toEqual({ kind: 'dropped' });
    });
  });

  describe('lock order: the experiment row first, then trial and attempt rows', () => {
    // While another transaction holds the experiment lock, a settle must wait on it WITHOUT having touched a trial or attempt
    // row. If it wrote the trial first (the old order) it would hold that row lock while waiting, and a cancel that holds the
    // experiment lock and then updates the trial would be in a deadlock (40P01) with it.
    const attemptRowIsFree = async (tx: Parameters<typeof trialRowIsFree>[0], trialId: string) => {
      try {
        await tx.$queryRaw`SELECT id FROM trial_attempt WHERE trial_id = ${trialId} FOR UPDATE NOWAIT`;
        return true;
      } catch {
        return false;
      }
    };

    it('settleTrial', async () => {
      const ex = await claimedExperiment(1);
      let settling!: Promise<unknown>;
      await withExperimentLock(prisma, ex.id, async (tx) => {
        settling = settleTrial(prisma, ctx(ex), done());
        await sleep(400);
        expect(await trialRowIsFree(tx, ex.trialIds[0])).toBe(true);
        expect(await attemptRowIsFree(tx, ex.trialIds[0])).toBe(true);
      });
      expect(await settling).toEqual({ kind: 'done' });
      expect((await trial(ex.trialIds[0])).status).toBe('done');
    });

    it('settleTrial after a cancel that committed while it waited: the late result is dropped, nothing is written', async () => {
      const ex = await claimedExperiment(1);
      let settling!: Promise<unknown>;
      await withExperimentLock(prisma, ex.id, async (tx) => {
        settling = settleTrial(prisma, ctx(ex), done());
        await sleep(400);
        await tx.$executeRaw`UPDATE trial SET status = 'cancelled'::trial_status, error_class = 'cancelled'::error_class WHERE id = ${ex.trialIds[0]}`;
        await tx.$executeRaw`UPDATE trial_attempt SET result = 'cancelled'::attempt_result, ended_at = now() WHERE trial_id = ${ex.trialIds[0]}`;
        await tx.$executeRaw`UPDATE experiment SET status = 'cancelled'::experiment_status, finished_at = now() WHERE id = ${ex.id}`;
      });
      expect(await settling).toEqual({ kind: 'dropped' });
      expect(await trial(ex.trialIds[0])).toMatchObject({ status: 'cancelled', passed: null });
      expect(await prisma.trace.count({ where: { trialId: ex.trialIds[0] } })).toBe(0);
      expect(await expStatus(ex.id)).toBe('cancelled');
    });

    it('settleOrphan', async () => {
      const ex = await claimedExperiment(1);
      await prisma.trial.update({ where: { id: ex.trialIds[0] }, data: { heartbeatAt: new Date(NOW.getTime() - 3_600_000) } });
      let settling!: Promise<unknown>;
      await withExperimentLock(prisma, ex.id, async (tx) => {
        settling = settleOrphan(prisma, ex.trialIds[0], new Date(NOW.getTime() - 480_000), NOW);
        await sleep(400);
        expect(await trialRowIsFree(tx, ex.trialIds[0])).toBe(true);
        expect(await attemptRowIsFree(tx, ex.trialIds[0])).toBe(true);
      });
      expect(await settling).toMatchObject({ kind: 'requeued' });
    });
  });

  describe('refreshExperimentStatus', () => {
    it('is the derivation: running while anything is open, completed when all done, partial with an errored trial', async () => {
      const ex = await fx.experiment({ configIds: [cfg], taskIds: ['scs-01-a', 'scs-02-b'], status: 'running' });
      expect(await refreshExperimentStatus(prisma, ex.id, NOW)).toBe('running');
      await prisma.trial.update({ where: { id: ex.trialIds[0] }, data: { status: 'done', passed: true, exitReason: 'completed' } });
      expect(await refreshExperimentStatus(prisma, ex.id, NOW)).toBe('running');
      await prisma.trial.update({ where: { id: ex.trialIds[1] }, data: { status: 'done', passed: false, exitReason: 'completed', failureCategory: 'wrong_answer', failureEvidence: { rule: 10, category: 'wrong_answer', detail: 'fixture' } } });
      expect(await refreshExperimentStatus(prisma, ex.id, NOW)).toBe('completed');
      const e = await prisma.experiment.findUniqueOrThrow({ where: { id: ex.id } });
      expect(e).toMatchObject({ status: 'completed' });
      expect(e.finishedAt).toEqual(NOW);
    });

    it('never writes completed while a trial is errored: it writes partial (D-8)', async () => {
      const ex = await fx.experiment({ configIds: [cfg], taskIds: ['scs-01-a', 'scs-02-b'], status: 'running' });
      await prisma.trial.update({ where: { id: ex.trialIds[0] }, data: { status: 'done', passed: true, exitReason: 'completed' } });
      await prisma.trial.update({ where: { id: ex.trialIds[1] }, data: { status: 'errored', errorClass: 'config_invalid' } });
      expect(await refreshExperimentStatus(prisma, ex.id, NOW)).toBe('partial');
    });

    it('works inside a transaction, and a cancelled experiment stays cancelled', async () => {
      const ex = await fx.experiment({ configIds: [cfg], taskIds: ['scs-01-a'], status: 'running' });
      await prisma.trial.update({ where: { id: ex.trialIds[0] }, data: { status: 'done', passed: true, exitReason: 'completed' } });
      expect(await prisma.$transaction((tx) => refreshExperimentStatus(tx, ex.id, NOW))).toBe('completed');
      const c = await fx.experiment({ configIds: [cfg], taskIds: ['scs-01-a'], status: 'running' });
      await prisma.experiment.update({ where: { id: c.id }, data: { status: 'cancelled' } });
      await prisma.trial.update({ where: { id: c.trialIds[0] }, data: { status: 'cancelled', errorClass: 'cancelled' } });
      expect(await refreshExperimentStatus(prisma, c.id, NOW)).toBe('cancelled');
    });

    it('rejects an unknown experiment', async () => {
      await expect(refreshExperimentStatus(prisma, 'nope', NOW)).rejects.toThrow(/not found/);
    });

    it('reconcileExperiments finishes a running experiment whose trials are all terminal (a crash between commit and refresh)', async () => {
      const ex = await fx.experiment({ configIds: [cfg], taskIds: ['scs-01-a'], status: 'running' });
      await prisma.trial.update({ where: { id: ex.trialIds[0] }, data: { status: 'done', passed: true, exitReason: 'completed' } });
      expect(await reconcileExperiments(prisma, NOW)).toBeGreaterThanOrEqual(1);
      expect(await expStatus(ex.id)).toBe('completed');
      const open = await fx.experiment({ configIds: [cfg], taskIds: ['scs-01-a'], status: 'running' });
      await reconcileExperiments(prisma, NOW);
      expect(await expStatus(open.id)).toBe('running');
    });
  });

  describe('D-8 detection', () => {
    it('recognises the error Postgres raises when the trigger fires', async () => {
      const ex = await fx.experiment({ configIds: [cfg], taskIds: ['scs-01-a'], status: 'running' });
      await prisma.trial.update({ where: { id: ex.trialIds[0] }, data: { status: 'errored', errorClass: 'config_invalid' } });
      let caught: unknown;
      await prisma.experiment.update({ where: { id: ex.id }, data: { status: 'completed' } }).catch((e) => (caught = e));
      expect(caught).toBeDefined();
      expect(isD8Violation(caught)).toBe(true);
      // the same through an interactive transaction, which is how settle meets it
      const inTx = await sqlState(prisma.$transaction((tx) => tx.experiment.update({ where: { id: ex.id }, data: { status: 'completed' } })));
      expect(inTx).not.toBeNull();
      let txErr: unknown;
      await prisma.$transaction((tx) => tx.experiment.update({ where: { id: ex.id }, data: { status: 'completed' } })).catch((e) => (txErr = e));
      expect(isD8Violation(txErr)).toBe(true);
    });

    it('does not mistake other errors for it', () => {
      expect(isD8Violation(new Error('connection reset'))).toBe(false);
      expect(isD8Violation({ code: '23505' })).toBe(false);
      expect(isD8Violation(null)).toBe(false);
    });

    it('withD8Retry runs the work once more after a D-8 violation, and gives up after the second', async () => {
      const d8 = Object.assign(new Error('D-8: experiment x cannot be completed'), { code: '23514' });
      const flaky = jest.fn().mockRejectedValueOnce(d8).mockResolvedValue('ok');
      await expect(withD8Retry(flaky)).resolves.toBe('ok');
      expect(flaky).toHaveBeenCalledTimes(2);

      const stuck = jest.fn().mockRejectedValue(d8);
      await expect(withD8Retry(stuck)).rejects.toBe(d8);
      expect(stuck).toHaveBeenCalledTimes(2);

      const other = jest.fn().mockRejectedValue(new Error('boom'));
      await expect(withD8Retry(other)).rejects.toThrow('boom');
      expect(other).toHaveBeenCalledTimes(1);
    });
  });
});
