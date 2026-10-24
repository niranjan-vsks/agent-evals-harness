/**
 * ExperimentsService and the HTTP routes on top of the REAL Scheduler, against the real-HTTP fake worker (test/fake-worker.ts):
 * the card's gate scenarios (e), (f), (g), the cancel races that went unseen while the two halves were only tested apart, and
 * the lock order they depend on.
 *
 * Loaded by src/experiments/experiments.e2e.spec.ts, because jest's rootDir is src.
 */
import { ConflictException, INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ulid } from '../src/common/ulid';
import { ExperimentsService } from '../src/experiments/service';
import { PrismaService } from '../src/prisma/prisma.service';
import { Scheduler } from '../src/scheduler/scheduler';
import { FakeWorkerServer } from './fake-worker';
import { Fixtures, sleep, waitFor } from './helpers';

const DEADLOCK = /40P01|deadlock|could not store/i;

describe('experiments on the real scheduler and the fake worker', () => {
  const fake = new FakeWorkerServer();
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  let scheduler: Scheduler;
  let experiments: ExperimentsService;
  let fx: Fixtures;
  let cfgA: string;
  let cfgB: string;
  let cfgOnly: string;
  let counter = 0;
  const saved = { workerUrl: process.env.WORKER_URL, heartbeat: process.env.SCHEDULER_HEARTBEAT_MS };

  beforeAll(async () => {
    await fake.start();
    process.env.WORKER_URL = fake.url;
    process.env.SCHEDULER_HEARTBEAT_MS = '50';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile(); // the real WorkerClient and Scheduler
    app = moduleRef.createNestApplication();
    await app.init();
    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);
    scheduler = app.get(Scheduler);
    experiments = app.get(ExperimentsService);
    fx = new Fixtures(prisma);
    const base = await fx.base();
    cfgA = await fx.config(base, 'xe config A');
    cfgB = await fx.config(base, 'xe config B');
    cfgOnly = await fx.config(base, 'xe config only');
    await fx.tasks([
      'sxe-01-ok',
      'sxe-02-ok',
      'sxe-03-fail',
      'sxe-04-ok',
      ...['01', '02', '03', '04', '05'].map((n) => `sxf-${n}-400`),
      'sxg-01-slow',
      'sxg-02-ok',
      'sxg-03-ok',
      'sxg-11-slow',
      'sxg-12-slow',
      ...['01', '02', '03', '04', '05', '06'].map((n) => `sxr-${n}-slow`),
      ...['11', '12', '13', '14', '15', '16'].map((n) => `sxr-${n}-slow`),
      'sxi-01-slow',
      'sxi-02-ok',
    ]);
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
    await fake.stop();
    if (saved.workerUrl === undefined) delete process.env.WORKER_URL;
    else process.env.WORKER_URL = saved.workerUrl;
    if (saved.heartbeat === undefined) delete process.env.SCHEDULER_HEARTBEAT_MS;
    else process.env.SCHEDULER_HEARTBEAT_MS = saved.heartbeat;
  });

  beforeEach(async () => {
    fake.reset();
    scheduler.clock = () => new Date();
    // The tests drive tick() by hand; a background tick kicked by start, extend or resume would race their counts.
    jest.spyOn(scheduler, 'kick').mockImplementation(() => undefined);
    const stray = await fx.isolate(); // running trials other specs left behind count against the limit
    scheduler.opts.maxConcurrent = 2 + stray;
  });

  afterEach(async () => {
    fake.openGate();
    await scheduler.idle();
    jest.restoreAllMocks();
  });

  const stray = () => scheduler.opts.maxConcurrent - 2;
  const name = (what: string) => `${what} #${++counter} ${Date.now()}`;
  const status = async (id: string) => (await prisma.experiment.findUniqueOrThrow({ where: { id } })).status;

  /** POST /experiments through the real route; the experiment is tracked for cleanup. */
  async function create(taskIds: string[], nTrials: number, configIds = [cfgA, cfgB]): Promise<string> {
    const res = await http.post('/experiments').send({ name: name('xe'), config_ids: configIds, task_ids: taskIds, n_trials: nTrials });
    expect(res.status).toBe(201);
    fx.track(res.body.id);
    return res.body.id;
  }

  /** 3 concurrent ticks, so a missing claim guard double-dispatches; then wait for the dispatches to settle. */
  async function round(): Promise<number> {
    const claimed = await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
    await scheduler.idle();
    return claimed.reduce((a, b) => a + b, 0);
  }
  async function runUntil(id: string, wanted: (s: string) => boolean, maxRounds = 60): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      if (wanted(await status(id))) return;
      await round();
    }
    throw new Error(`experiment ${id} did not reach the wanted status: ${await status(id)}`);
  }
  const trialRows = (experimentId: string) =>
    prisma.trial.findMany({ where: { experimentId }, include: { attempts: { orderBy: { attemptNo: 'asc' } } }, orderBy: { id: 'asc' } });

  /** Records every message the Nest loggers are asked to write as an error or a warning, and keeps them quiet. */
  function captureLogs(): { messages: () => string[] } {
    const seen: string[] = [];
    for (const level of ['error', 'warn'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((m: unknown) => void seen.push(String(m)));
    }
    return { messages: () => seen };
  }

  describe('card scenario (f): extend', () => {
    it('2 configs x 4 tasks x N=2 completes; extend to 3 adds exactly 8 trials with trial_index 2; completed -> running -> completed (24)', async () => {
      const id = await create(['sxe-01-ok', 'sxe-02-ok', 'sxe-03-fail', 'sxe-04-ok'], 2);
      await http.post(`/experiments/${id}/start`).expect(200);
      await runUntil(id, (s) => s === 'completed');
      const seen = [await status(id)];
      const first = (await http.get(`/experiments/${id}`)).body;
      expect(first).toMatchObject({ status: 'completed', n_trials: 2, progress: { done: 16, total: 16 } });
      const old = new Set((await trialRows(id)).map((t) => t.id));
      expect(old.size).toBe(16);

      const res = await http.post(`/experiments/${id}/extend`).send({ n_trials: 3 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'running', n_trials: 3, finished_at: null, paused: false });
      seen.push(res.body.status);
      const all = (await http.get(`/experiments/${id}/trials`)).body as { id: string; trial_index: number; status: string }[];
      const added = all.filter((t) => !old.has(t.id));
      expect(all).toHaveLength(24);
      expect(added).toHaveLength(8);
      expect(added.every((t) => t.trial_index === 2 && t.status === 'pending')).toBe(true);
      expect(all.filter((t) => old.has(t.id)).every((t) => t.status === 'done')).toBe(true); // the old trials are untouched

      const runsBefore = fake.runs.length;
      await runUntil(id, (s) => s === 'completed');
      seen.push(await status(id));
      expect(seen).toEqual(['completed', 'running', 'completed']);
      expect(fake.runs.length - runsBefore).toBe(8); // only the new trials ran
      const final = (await http.get(`/experiments/${id}`)).body;
      expect(final.progress).toEqual({ pending: 0, running: 0, done: 24, errored: 0, cancelled: 0, total: 24 });
      expect((await trialRows(id)).every((t) => t.attemptCount === 1 && t.attempts.length === 1)).toBe(true);
    });
  });

  describe('card scenario (g): cancel', () => {
    it('POST cancel on a running experiment: pending -> cancelled, experiment cancelled (never partial or completed), worker saw DELETE', async () => {
      const id = await create(['sxg-01-slow', 'sxg-02-ok', 'sxg-03-ok'], 1);
      fake.closeGate();
      await http.post(`/experiments/${id}/start`).expect(200);
      expect(await scheduler.tick()).toBe(2); // the 2 -slow trials of sxg-01 (claim order: trial_index, task_id, position)
      await waitFor(() => fake.inFlight === 2, 5000, '2 worker calls in flight');
      const running = (await trialRows(id)).filter((t) => t.status === 'running');
      expect(running).toHaveLength(2);
      expect(running.every((t) => t.taskId === 'sxg-01-slow')).toBe(true);
      expect(await status(id)).toBe('running');

      const res = await http.post(`/experiments/${id}/cancel`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'cancelled', progress: { pending: 0, running: 0, done: 0, errored: 0, cancelled: 6, total: 6 } });
      expect(res.body.finished_at).not.toBeNull();
      expect([...fake.cancelled].sort()).toEqual(running.map((t) => t.id).sort()); // DELETE /trials/:id for exactly the in-flight ones

      const rows = await trialRows(id);
      expect(rows.every((t) => t.status === 'cancelled' && t.errorClass === 'cancelled' && t.passed === null)).toBe(true);
      for (const t of rows.filter((r) => r.attempts.length > 0)) expect(t.attempts.map((a) => a.result)).toEqual(['cancelled']);
      expect(rows.filter((t) => t.attempts.length > 0).map((t) => t.id).sort()).toEqual(running.map((t) => t.id).sort());

      // the worker still answers (its DELETE only signals the child): the late results are dropped
      fake.openGate();
      await scheduler.idle();
      const after = await trialRows(id);
      expect(after.every((t) => t.status === 'cancelled' && t.passed === null)).toBe(true);
      expect(await prisma.trace.count({ where: { trialId: { in: after.map((t) => t.id) } } })).toBe(0);
      expect(await prisma.graderResult.count({ where: { trialId: { in: after.map((t) => t.id) } } })).toBe(0);
      expect(await status(id)).toBe('cancelled');
      expect(await scheduler.tick()).toBe(0);
    });

    it('(g2) a late result after the cancel leaves the experiment cancelled, whatever refreshes the status afterwards', async () => {
      const id = await create(['sxg-11-slow', 'sxg-12-slow'], 1);
      fake.closeGate();
      await http.post(`/experiments/${id}/start`).expect(200);
      expect(await scheduler.tick()).toBe(2);
      await waitFor(() => fake.inFlight === 2, 5000, '2 worker calls in flight');
      await http.post(`/experiments/${id}/cancel`).expect(200);
      const finishedAt = (await prisma.experiment.findUniqueOrThrow({ where: { id } })).finishedAt;

      fake.openGate();
      await scheduler.idle(); // the 2 late results arrive here and are dropped
      expect(await status(id)).toBe('cancelled');
      await scheduler.recoverOrphans(); // reconcile re-derives running experiments only
      expect(await status(id)).toBe('cancelled');
      expect((await prisma.experiment.findUniqueOrThrow({ where: { id } })).finishedAt).toEqual(finishedAt);
      expect((await http.get(`/experiments/${id}`)).body.progress).toMatchObject({ cancelled: 4, done: 0, total: 4 });
    });

    it('create -> start -> tick -> cancel through ExperimentsService on the real Scheduler', async () => {
      const created = await experiments.create({ name: name('integration'), config_ids: [cfgA, cfgB], task_ids: ['sxi-01-slow', 'sxi-02-ok'], n_trials: 1 });
      fx.track(created.id);
      expect(created.status).toBe('draft');
      const started = await experiments.start(created.id);
      expect(started).toMatchObject({ status: 'queued', progress: { pending: 4, total: 4 } });

      fake.closeGate();
      expect(await scheduler.tick()).toBe(2);
      await waitFor(() => fake.inFlight === 2, 5000, '2 worker calls in flight');
      expect(await status(created.id)).toBe('running');
      const running = (await trialRows(created.id)).filter((t) => t.status === 'running').map((t) => t.id);

      const cancelSpy = jest.spyOn(scheduler, 'cancelOnWorker');
      const cancelled = await experiments.cancel(created.id);
      expect(cancelled).toMatchObject({ status: 'cancelled', progress: { cancelled: 4, running: 0, pending: 0 } });
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect([...cancelSpy.mock.calls[0][0]].sort()).toEqual([...running].sort());
      expect([...fake.cancelled].sort()).toEqual([...running].sort());
      for (const t of (await trialRows(created.id)).filter((r) => running.includes(r.id))) {
        expect(t.attempts.map((a) => [a.attemptNo, a.result])).toEqual([[1, 'cancelled']]);
      }
    });
  });

  describe('card scenario (e): the 5th terminal error is the last trial', () => {
    it('ends partial with no pause_reason, resume is 409, and extend dispatches normally', async () => {
      const bad = ['01', '02', '03', '04', '05'].map((n) => `sxf-${n}-400`);
      const ex = await fx.experiment({ configIds: [cfgOnly], taskIds: bad, nTrials: 1 }); // exactly 5 trials
      scheduler.opts.maxConcurrent = 1 + stray(); // one at a time: the 5th error is unambiguously the last
      await runUntil(ex.id, (s) => s === 'partial');
      const e = await prisma.experiment.findUniqueOrThrow({ where: { id: ex.id } });
      expect(e).toMatchObject({ status: 'partial', pauseReason: null });
      expect((await trialRows(ex.id)).filter((t) => t.status === 'errored')).toHaveLength(5);
      expect(fake.runs).toHaveLength(5);
      expect((await experiments.get(ex.id)).paused).toBe(false);

      await expect(experiments.resume(ex.id)).rejects.toBeInstanceOf(ConflictException);
      expect((await http.post(`/experiments/${ex.id}/resume`)).status).toBe(409);

      // extend reopens it; the new trials are dispatched, not held back by a stale count of 5 or a stale pause_reason
      const extended = await http.post(`/experiments/${ex.id}/extend`).send({ n_trials: 2 });
      expect(extended.status).toBe(200);
      expect(extended.body).toMatchObject({ status: 'running', pause_reason: null, paused: false, progress: { pending: 5, errored: 5, total: 10 } });
      expect(await scheduler.tick()).toBe(1);
      await scheduler.idle();
      expect(fake.runs).toHaveLength(6);
      expect((await prisma.experiment.findUniqueOrThrow({ where: { id: ex.id } })).pauseReason).toBeNull();
      expect(await status(ex.id)).toBe('running');
      await runUntil(ex.id, (s) => s === 'partial');
      expect(fake.runs).toHaveLength(10);
      expect((await prisma.experiment.findUniqueOrThrow({ where: { id: ex.id } })).pauseReason).toBeNull();
    });
  });

  describe('cancel racing the scheduler (the lock-order deadlock of the review: 11 of 12 iterations)', () => {
    const ITERATIONS = 12;

    it(`cancel racing in-flight settles: ${ITERATIONS} iterations, cancel returns, no deadlock, running trials cancelled and told to the worker`, async () => {
      const logs = captureLogs();
      const told = jest.spyOn(scheduler, 'cancelOnWorker');
      const taskIds = ['01', '02', '03', '04', '05', '06'].map((n) => `sxr-${n}-slow`);
      let cancelledRunning = 0;
      let cancelledRuns = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        told.mockClear();
        const id = await create(taskIds, 1); // 2 configs x 6 tasks = 12 trials, all in flight
        scheduler.opts.maxConcurrent = stray() + 12;
        fake.reset();
        fake.closeGate();
        await experiments.start(id);
        expect(await scheduler.tick()).toBe(12);
        await waitFor(() => fake.inFlight === 12, 5000, '12 worker calls in flight');

        // release the worker and cancel at once: the 12 settles and the cancel meet at the experiment row
        const cancelling = sleep(i % 4)
          .then(() => experiments.cancel(id))
          .catch((e: unknown) => {
            if (!(e instanceof ConflictException)) throw e; // any other failure (a deadlock, say) fails the test
            return undefined;
          });
        fake.openGate();
        const result = await cancelling;
        await scheduler.idle();

        const rows = await trialRows(id);
        expect(rows.filter((t) => t.status === 'pending' || t.status === 'running')).toHaveLength(0);
        expect(rows.every((t) => t.attempts.every((a) => a.endedAt !== null))).toBe(true);
        expect(rows.every((t) => t.status === 'cancelled' || t.status === 'done')).toBe(true);
        const cancelled = rows.filter((t) => t.status === 'cancelled');
        const doneRows = rows.filter((t) => t.status === 'done');
        for (const t of doneRows) expect(t.attempts.map((a) => a.result)).toEqual(['done']); // a settle that won is whole
        if (result === undefined || cancelled.length === 0) {
          // the 12 settles finished before the cancel ran: it answered 409 'completed'; nothing may be half done
          expect(told).not.toHaveBeenCalled();
          expect(await status(id)).toBe('completed');
          continue;
        }
        expect(result.status).toBe('cancelled');
        expect(told).toHaveBeenCalledTimes(1);
        const ids = told.mock.calls[0][0];
        // every trial that was running when the cancel committed: cancelled, attempt closed 'cancelled', passed to the worker
        expect([...ids].sort()).toEqual(cancelled.map((t) => t.id).sort());
        for (const t of cancelled) expect(t.attempts.map((a) => a.result)).toEqual(['cancelled']);
        expect(await status(id)).toBe('cancelled');
        cancelledRunning += ids.length;
        cancelledRuns++;
      }
      expect(logs.messages().filter((m) => DEADLOCK.test(m))).toEqual([]);
      expect(cancelledRuns).toBeGreaterThan(0); // the interleaving was exercised
      expect(cancelledRunning).toBeGreaterThan(0);
    });

    it(`cancel racing tick() claims of a queued experiment: ${ITERATIONS} iterations, no deadlock, nothing runs after the cancel`, async () => {
      const logs = captureLogs();
      const told = jest.spyOn(scheduler, 'cancelOnWorker');
      let withRunning = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        told.mockClear();
        const id = await create(['11', '12', '13', '14', '15', '16'].map((n) => `sxr-${n}-slow`), 1); // 12 pending trials
        fake.reset();
        fake.closeGate();
        await experiments.start(id);
        scheduler.opts.maxConcurrent = stray() + 2;

        // the first claim of a queued experiment also writes the experiment row (queued -> running): the old deadlock
        const delay = [0, 3, 6, 10, 15, 25][i % 6];
        const [, , cancelled] = await Promise.all([scheduler.tick(), scheduler.tick(), sleep(delay).then(() => experiments.cancel(id))]);
        fake.openGate();
        await scheduler.idle();

        expect(cancelled.status).toBe('cancelled');
        const ids = told.mock.calls[0][0];
        const rows = await trialRows(id);
        expect(rows.every((t) => t.status === 'cancelled')).toBe(true); // nothing was left running or pending, none finished
        const claimed = rows.filter((t) => t.attempts.length > 0);
        expect(claimed.map((t) => t.id).sort()).toEqual([...ids].sort()); // claimed before the cancel <=> reported to the worker
        for (const t of claimed) expect(t.attempts.map((a) => a.result)).toEqual(['cancelled']);
        expect(claimed.length).toBeLessThanOrEqual(2);
        expect(await status(id)).toBe('cancelled');
        expect(await scheduler.tick()).toBe(0); // and a tick after the cancel claims nothing
        if (ids.length > 0) withRunning++;
      }
      expect(logs.messages().filter((m) => DEADLOCK.test(m))).toEqual([]);
      expect(withRunning).toBeGreaterThan(0);
    });

    it('cancel reports a trial that became running while it waited: the ids come from the UPDATE itself, never from an earlier read', async () => {
      const id = await create(['sxg-11-slow', 'sxg-12-slow'], 1);
      await experiments.start(id);
      const pending = await trialRows(id);
      const target = pending[0].id;

      // A writer that does not lock the experiment first (what the old claim did) holds the trial row, uncommitted:
      // pending -> running with its attempt row. cancel locks the experiment, then has to wait for that row.
      let release!: () => void;
      const hold = new Promise<void>((ok) => (release = ok));
      const legacyClaim = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            UPDATE trial SET status = 'running'::trial_status, attempt_count = 1, started_at = now(), heartbeat_at = now()
            WHERE id = ${target}`;
          await tx.trialAttempt.create({ data: { id: ulid(), trialId: target, attemptNo: 1, startedAt: new Date() } });
          await hold;
        },
        { timeout: 30_000 },
      );
      await sleep(150);
      const told = jest.spyOn(scheduler, 'cancelOnWorker');
      const cancelling = experiments.cancel(id);
      await waitFor(
        async () => {
          const r = await prisma.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%cancelled%'`;
          return r[0].n > 0;
        },
        5000,
        'cancel to wait for the trial row',
      );
      release();
      await legacyClaim;
      const result = await cancelling;

      expect(result.status).toBe('cancelled');
      expect(told).toHaveBeenCalledTimes(1);
      expect(told.mock.calls[0][0]).toEqual([target]); // an earlier read of the running ids would have said []
      const rows = await trialRows(id);
      expect(rows.every((t) => t.status === 'cancelled')).toBe(true);
      expect(rows.find((t) => t.id === target)!.attempts.map((a) => a.result)).toEqual(['cancelled']);
    });
  });
});
