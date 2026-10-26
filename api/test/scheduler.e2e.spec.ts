/**
 * The P3 card section 8 scenarios against a real HTTP fake worker: the whole Nest app is built with the REAL
 * WorkerClient, WORKER_URL points at test/fake-worker.ts, and time is moved through Scheduler.clock. Experiments are
 * inserted directly (test/helpers.ts), so this does not depend on ExperimentsService.
 *
 * Loaded by src/scheduler/scheduler.e2e.spec.ts, because jest's rootDir is src.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { ExperimentsService } from '../src/experiments/service';
import { PrismaService } from '../src/prisma/prisma.service';
import { Scheduler } from '../src/scheduler/scheduler';
import { WorkerClient } from '../src/worker-client/worker-client';
import { FakeWorkerServer } from './fake-worker';
import { Fixtures, PLACEHOLDER_PRICE, waitFor } from './helpers';

describe('scheduler against the fake worker (P3 gate 1)', () => {
  const fake = new FakeWorkerServer();
  let app: INestApplication;
  let prisma: PrismaService;
  let scheduler: Scheduler;
  let experiments: ExperimentsService;
  let fx: Fixtures;
  let base: Awaited<ReturnType<Fixtures['base']>>;
  let cfgA: string;
  let cfgB: string;
  let offsetMs = 0;
  let kickSpy: jest.SpyInstance;
  const saved = { workerUrl: process.env.WORKER_URL, heartbeat: process.env.SCHEDULER_HEARTBEAT_MS };

  beforeAll(async () => {
    await fake.start();
    process.env.WORKER_URL = fake.url;
    process.env.SCHEDULER_HEARTBEAT_MS = '50';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile(); // the real WorkerClient
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    scheduler = app.get(Scheduler);
    experiments = app.get(ExperimentsService);
    fx = new Fixtures(prisma);
    base = await fx.base();
    cfgA = await fx.config(base, 'config A');
    cfgB = await fx.config(base, 'config B');
    await fx.tasks([
      ...['01', '02', '04', '05', '06'].map((n) => `sce-${n}-ok`),
      'sce-03-fail',
      'sce-10-429',
      'sce-11-crash',
      ...['01', '02', '03', '04', '05', '06', '07'].map((n) => `scb-${n}-400`), // scb sorts before sce: these run first
      'sce-30-bp',
      ...['31', '32', '33', '34', '35', '36'].map((n) => `sce-${n}-slow`),
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
    offsetMs = 0;
    scheduler.clock = () => new Date(Date.now() + offsetMs);
    // The tests drive tick() by hand; a background tick kicked by resume or extend would race their round() counts.
    kickSpy = jest.spyOn(scheduler, 'kick').mockImplementation(() => undefined);
    const stray = await fx.isolate(); // running trials other specs left behind count against the limit
    scheduler.opts.maxConcurrent = 2 + stray;
  });

  afterEach(async () => {
    fake.openGate();
    await scheduler.idle();
    scheduler.clock = () => new Date();
    kickSpy.mockRestore();
  });

  const advance = (ms: number) => {
    offsetMs += ms;
  };
  /** 3 concurrent ticks, so a missing claim guard double-dispatches; then wait for the dispatches to settle. */
  async function round(): Promise<number> {
    const claimed = await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
    await scheduler.idle();
    return claimed.reduce((a, b) => a + b, 0);
  }
  async function runUntil(experimentId: string, done: (status: string) => boolean, maxRounds = 60): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      if (done(await status(experimentId))) return;
      await round();
    }
    throw new Error(`experiment ${experimentId} did not reach the wanted status: ${await status(experimentId)}`);
  }
  const status = async (id: string) => (await prisma.experiment.findUniqueOrThrow({ where: { id } })).status;
  const trials = (experimentId: string) =>
    prisma.trial.findMany({
      where: { experimentId },
      include: { attempts: { orderBy: { attemptNo: 'asc' } } },
      orderBy: [{ trialIndex: 'asc' }, { taskId: 'asc' }, { configId: 'asc' }],
    });
  const trial = async (id: string) => prisma.trial.findUniqueOrThrow({ where: { id }, include: { attempts: { orderBy: { attemptNo: 'asc' } } } });

  it('(a) 2 configs x 4 tasks x N=2 runs to completed, 16 trials, 1 attempt each, 16 worker calls, despite concurrent ticks', async () => {
    const ex = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: ['sce-01-ok', 'sce-02-ok', 'sce-03-fail', 'sce-04-ok'], nTrials: 2 });
    expect(ex.trialIds).toHaveLength(16);
    await runUntil(ex.id, (s) => s === 'completed');

    const rows = await trials(ex.id);
    expect(rows).toHaveLength(16);
    for (const t of rows) {
      expect(t.status).toBe('done');
      expect(t.attemptCount).toBe(1);
      expect(t.attempts).toHaveLength(1);
      expect(t.attempts[0]).toMatchObject({ attemptNo: 1, result: 'done' });
      expect(t.attempts[0].endedAt).not.toBeNull();
    }
    expect(fake.runs).toHaveLength(16);
    expect(new Set(fake.runs.map((s) => s.trial_id)).size).toBe(16);
    expect(fake.runs.every((s) => s.attempt === 1)).toBe(true);
    const e = await prisma.experiment.findUniqueOrThrow({ where: { id: ex.id } });
    expect(e.status).toBe('completed');
    expect(e.startedAt).not.toBeNull();
    expect(e.finishedAt).not.toBeNull();
    expect(e.pauseReason).toBeNull();
  });

  it('writes the trace and grader rows and keeps D-14 (passed is the AND of the graders)', async () => {
    const ex = await fx.experiment({ configIds: [cfgA], taskIds: ['sce-01-ok', 'sce-03-fail'] });
    await runUntil(ex.id, (s) => s === 'completed');
    const rows = await trials(ex.id);
    for (const t of rows) {
      expect(t.status).toBe('done');
      const graders = await prisma.graderResult.findMany({ where: { trialId: t.id } });
      expect(graders.length).toBeGreaterThan(0);
      expect(t.passed).toBe(graders.every((g) => g.passed));
      const trace = await prisma.trace.findUniqueOrThrow({ where: { trialId: t.id } });
      expect((trace.events as unknown[]).length).toBe(7);
      expect(trace.modelSlug).toBe(base.modelSlug);
      expect(t.exitReason).toBe('completed');
      expect(t.costUsd).not.toBeNull();
      expect(t.endedAt).not.toBeNull();
    }
    expect(Object.fromEntries(rows.map((t) => [t.taskId, t.passed]))).toEqual({ 'sce-01-ok': true, 'sce-03-fail': false });
  });

  it('D-7: the price snapshot placeholder is rewritten from the model at claim time, and the cost uses it', async () => {
    await prisma.model.update({ where: { id: base.modelId }, data: { inputPricePerMtok: 3, outputPricePerMtok: 4, cachedInputPricePerMtok: 5 } });
    try {
      const ex = await fx.experiment({ configIds: [cfgA], taskIds: ['sce-01-ok'] });
      expect((await trial(ex.trialIds[0])).priceSnapshot).toEqual(PLACEHOLDER_PRICE);
      await runUntil(ex.id, (s) => s === 'completed');
      const t = await trial(ex.trialIds[0]);
      expect(t.priceSnapshot).toEqual({ input_price_per_mtok: 3, output_price_per_mtok: 4, cached_input_price_per_mtok: 5 });
      expect(fake.runs[0].model).toMatchObject({ input_price_per_mtok: 3, output_price_per_mtok: 4, cached_input_price_per_mtok: 5 });
      expect(Number(t.costUsd)).toBeCloseTo((3000 * 3 + 40 * 4) / 1e6, 9);
    } finally {
      await prisma.model.update({ where: { id: base.modelId }, data: { inputPricePerMtok: 1, outputPricePerMtok: 2, cachedInputPricePerMtok: 0.5 } });
    }
  });

  it('(b) a -429 task: attempt 1 errored rate_limited, back to pending, not dispatched until the 30 s backoff passed, then done on attempt 2', async () => {
    const ex = await fx.experiment({ configIds: [cfgA], taskIds: ['sce-10-429'] });
    const id = ex.trialIds[0];
    expect(await round()).toBe(1);

    let t = await trial(id);
    expect(t.status).toBe('pending');
    expect(t.errorClass).toBe('rate_limited');
    expect(t.attemptCount).toBe(1);
    expect(t.attempts).toHaveLength(1);
    expect(t.attempts[0]).toMatchObject({ result: 'errored', errorClass: 'rate_limited' });
    expect(await status(ex.id)).toBe('running');

    expect(await round()).toBe(0); // inside the backoff
    advance(29_000);
    expect(await round()).toBe(0);
    expect(fake.runs).toHaveLength(1);
    advance(2_000);
    expect(await round()).toBe(1);

    t = await trial(id);
    expect(t.status).toBe('done');
    expect(t.attemptCount).toBe(2);
    expect(t.errorClass).toBeNull();
    expect(t.attempts.map((a) => [a.attemptNo, a.result])).toEqual([
      [1, 'errored'],
      [2, 'done'],
    ]);
    expect(fake.runs.map((s) => s.attempt)).toEqual([1, 2]);
    expect(await status(ex.id)).toBe('completed');
  });

  it('(c) a -crash task errors after exactly 3 attempts (backoffs 30 s then 60 s); the experiment ends partial, never completed', async () => {
    const ex = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: ['sce-01-ok', 'sce-11-crash'] });
    const seen = new Set<string>();
    const watch = async () => seen.add(await status(ex.id));
    const crash = () => trials(ex.id).then((r) => r.filter((t) => t.taskId === 'sce-11-crash'));
    await round(); // the 2 ok trials
    await round(); // attempt 1 of both crash trials
    await watch();
    expect((await crash()).map((t) => [t.status, t.attemptCount])).toEqual([
      ['pending', 1],
      ['pending', 1],
    ]);

    advance(29_000);
    expect(await round()).toBe(0);
    advance(2_000);
    expect(await round()).toBe(2); // attempt 2
    await watch();
    expect((await crash()).map((t) => [t.status, t.attemptCount])).toEqual([
      ['pending', 2],
      ['pending', 2],
    ]);

    advance(59_000);
    expect(await round()).toBe(0);
    advance(2_000);
    expect(await round()).toBe(2); // attempt 3
    await watch();
    expect(await round()).toBe(0);

    for (const t of await crash()) {
      expect(t.status).toBe('errored');
      expect(t.errorClass).toBe('worker_crash');
      expect(t.attemptCount).toBe(3);
      expect(t.attempts.map((a) => [a.attemptNo, a.result, a.errorClass])).toEqual([
        [1, 'errored', 'worker_crash'],
        [2, 'errored', 'worker_crash'],
        [3, 'errored', 'worker_crash'],
      ]);
    }
    expect(fake.runsFor('sce-11-crash')).toHaveLength(6);
    expect(await status(ex.id)).toBe('partial');
    expect((await prisma.experiment.findUniqueOrThrow({ where: { id: ex.id } })).finishedAt).not.toBeNull();
    expect(seen.has('completed')).toBe(false);
  });

  it('(d) a -400 task errors after 1 attempt; 5 in a row pause the experiment; resume continues', async () => {
    // 7 bad trials: the first 5 (6 when one was already in flight) pause it, the 1 or 2 left after the resume stay below 5
    const bad = ['01', '02', '03', '04', '05', '06', '07'].map((n) => `scb-${n}-400`);
    const ok = ['sce-01-ok', 'sce-02-ok', 'sce-04-ok'];
    const ex = await fx.experiment({ configIds: [cfgA], taskIds: [...bad, ...ok] });

    let e = await prisma.experiment.findUniqueOrThrow({ where: { id: ex.id } });
    for (let i = 0; i < 10 && !e.pauseReason; i++) {
      await round();
      e = await prisma.experiment.findUniqueOrThrow({ where: { id: ex.id } });
    }
    expect(e.pauseReason).toBe('circuit breaker: 5 consecutive terminal errors (last: config_invalid: scripted config_invalid)');
    expect(e.status).toBe('running');

    const errored = (await trials(ex.id)).filter((t) => t.status === 'errored');
    expect(errored.length).toBeGreaterThanOrEqual(5);
    for (const t of errored) {
      expect(t.taskId.endsWith('-400')).toBe(true);
      expect(t.attemptCount).toBe(1);
      expect(t.attempts).toHaveLength(1);
      expect(t.errorClass).toBe('config_invalid');
    }
    const dispatchedWhenPaused = fake.runs.length;
    for (let i = 0; i < 4; i++) expect(await round()).toBe(0);
    expect(fake.runs).toHaveLength(dispatchedWhenPaused);
    const pending = (await trials(ex.id)).filter((t) => t.status === 'pending');
    expect(pending.filter((t) => t.taskId.endsWith('-ok'))).toHaveLength(ok.length);

    // through the service, as POST /experiments/:id/resume does: it clears pause_reason and the breaker count
    const resumed = await experiments.resume(ex.id);
    expect(resumed).toMatchObject({ paused: false, pause_reason: null, status: 'running' });
    await expect(experiments.resume(ex.id)).rejects.toThrow(/not paused/); // a second resume is a 409
    await runUntil(ex.id, (s) => s === 'partial');
    const all = await trials(ex.id);
    expect(all.filter((t) => t.status === 'done')).toHaveLength(ok.length);
    expect(all.filter((t) => t.status === 'errored')).toHaveLength(bad.length);
    expect((await prisma.experiment.findUniqueOrThrow({ where: { id: ex.id } })).pauseReason).toBeNull();
  });

  it('(e) kill mid-dispatch: a running trial with a 1 hour old heartbeat is recovered and the next tick re-dispatches it to done', async () => {
    const ex = await fx.experiment({ configIds: [cfgA], taskIds: ['sce-01-ok'], status: 'running' });
    const id = ex.trialIds[0];
    const old = new Date(Date.now() - 3_600_000);
    await prisma.trial.update({ where: { id }, data: { status: 'running', attemptCount: 1, startedAt: old, heartbeatAt: old } });
    await prisma.trialAttempt.create({ data: { id: `orphan-a1-${id}`, trialId: id, attemptNo: 1, startedAt: old } });

    expect(await scheduler.recoverOrphans()).toBeGreaterThanOrEqual(1);
    let t = await trial(id);
    expect(t.status).toBe('pending');
    expect(t.errorClass).toBe('orphaned');
    expect(t.attemptCount).toBe(1);
    expect(t.attempts[0]).toMatchObject({ result: 'orphaned', errorClass: 'orphaned' });
    expect(t.attempts[0].endedAt).not.toBeNull();

    expect(await round()).toBe(0); // the 30 s backoff
    advance(31_000);
    expect(await round()).toBe(1);
    t = await trial(id);
    expect(t.status).toBe('done');
    expect(t.attemptCount).toBe(2);
    expect(t.attempts.map((a) => [a.attemptNo, a.result])).toEqual([
      [1, 'orphaned'],
      [2, 'done'],
    ]);
    expect(await status(ex.id)).toBe('completed');
  });

  it('(e) an orphan that used its 3 attempts ends errored (orphaned) and the experiment partial', async () => {
    const ex = await fx.experiment({ configIds: [cfgA], taskIds: ['sce-01-ok'], status: 'running' });
    const id = ex.trialIds[0];
    const old = new Date(Date.now() - 3_600_000);
    await prisma.trial.update({ where: { id }, data: { status: 'running', attemptCount: 3, startedAt: old, heartbeatAt: old } });
    for (const no of [1, 2, 3]) {
      await prisma.trialAttempt.create({
        data: {
          id: `orphan-a${no}-${id}`,
          trialId: id,
          attemptNo: no,
          startedAt: old,
          ...(no < 3 ? { endedAt: old, result: 'errored' as const, errorClass: 'worker_crash' as const } : {}),
        },
      });
    }
    await scheduler.recoverOrphans();
    const t = await trial(id);
    expect(t.status).toBe('errored');
    expect(t.errorClass).toBe('orphaned');
    expect(t.attempts.map((a) => a.result)).toEqual(['errored', 'errored', 'orphaned']);
    expect(await status(ex.id)).toBe('partial');
    expect(await round()).toBe(0);
    expect(fake.runs).toHaveLength(0);
  });

  it('backpressure: HTTP 429 twice then success keeps attempt_count at 1 across 3 attempt rows, with no error left', async () => {
    fake.backpressureCount = 2;
    const ex = await fx.experiment({ configIds: [cfgA], taskIds: ['sce-30-bp'] });
    const id = ex.trialIds[0];
    expect(await round()).toBe(1);
    let t = await trial(id);
    expect(t.status).toBe('pending');
    expect(t.errorClass).toBe('backpressure');
    expect(t.attemptCount).toBe(0); // given back
    expect(t.attempts[0]).toMatchObject({ result: 'errored', errorClass: 'backpressure' });

    expect(await round()).toBe(0); // 5 s backoff
    advance(6_000);
    expect(await round()).toBe(1);
    t = await trial(id);
    expect(t.status).toBe('pending');
    expect(t.attemptCount).toBe(0);
    advance(6_000);
    expect(await round()).toBe(1);

    t = await trial(id);
    expect(t.status).toBe('done');
    expect(t.attemptCount).toBe(1);
    expect(t.errorClass).toBeNull();
    expect(t.errorMessage).toBeNull();
    expect(t.attempts.map((a) => [a.attemptNo, a.result])).toEqual([
      [1, 'errored'],
      [2, 'errored'],
      [3, 'done'],
    ]);
    expect(fake.runsOfTrial(id).map((s) => s.attempt)).toEqual([1, 2, 3]);
    expect(await status(ex.id)).toBe('completed');
  });

  it('heartbeat_at moves while a -slow trial is in flight', async () => {
    fake.closeGate();
    const ex = await fx.experiment({ configIds: [cfgA], taskIds: ['sce-31-slow'] });
    const id = ex.trialIds[0];
    expect(await scheduler.tick()).toBe(1);
    const first = (await trial(id)).heartbeatAt!;
    await waitFor(async () => (await trial(id)).heartbeatAt!.getTime() > first.getTime() + 100, 5000, 'a heartbeat');
    expect((await trial(id)).status).toBe('running');
    fake.openGate();
    await scheduler.idle();
    expect((await trial(id)).status).toBe('done');
  });

  it('a trial cancelled in the database while in flight drops its late result', async () => {
    fake.closeGate();
    const ex = await fx.experiment({ configIds: [cfgA], taskIds: ['sce-31-slow'] });
    const id = ex.trialIds[0];
    expect(await scheduler.tick()).toBe(1);
    await waitFor(() => fake.inFlight === 1, 5000, 'the worker call');

    // what POST /experiments/:id/cancel does in its transaction
    await prisma.trial.update({ where: { id }, data: { status: 'cancelled', errorClass: 'cancelled', errorMessage: 'cancelled with the experiment' } });
    await prisma.trialAttempt.updateMany({ where: { trialId: id, result: null }, data: { result: 'cancelled', endedAt: new Date() } });
    await scheduler.cancelOnWorker([id]);
    expect(fake.cancelled).toEqual([id]);

    fake.openGate();
    await scheduler.idle();
    const t = await trial(id);
    expect(t.status).toBe('cancelled');
    expect(t.passed).toBeNull();
    expect(t.attempts.map((a) => a.result)).toEqual(['cancelled']);
    expect(await prisma.trace.count({ where: { trialId: id } })).toBe(0);
    expect(await prisma.graderResult.count({ where: { trialId: id } })).toBe(0);
  });

  it('cancelOnWorker never throws, also for a trial the worker does not run', async () => {
    await expect(scheduler.cancelOnWorker(['no-such-trial'])).resolves.toBeUndefined();
    expect(fake.missed).toEqual(['no-such-trial']);
  });

  it('MAX_CONCURRENT_TRIALS: concurrent ticks from an empty state never put more than 2 in flight, over several rounds', async () => {
    const slow = ['31', '32'].map((n) => `sce-${n}-slow`);
    const stray = scheduler.opts.maxConcurrent - 2; // running trials of other specs, set by beforeEach
    for (let round = 0; round < 8; round++) {
      fake.closeGate();
      await fx.experiment({ configIds: [cfgA, cfgB], taskIds: slow }); // 4 pending trials for 2 slots
      // nothing of ours is running now; the 3 callers all see 0 running and a list of due trials
      const claims = await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
      expect(claims.reduce((a, b) => a + b, 0)).toBe(2);
      expect(await prisma.trial.count({ where: { status: 'running' } })).toBeLessThanOrEqual(scheduler.opts.maxConcurrent);
      await waitFor(() => fake.inFlight === 2, 5000, '2 calls in flight');
      expect(await prisma.trial.count({ where: { status: 'running' } })).toBe(stray + 2);
      fake.openGate();
      await scheduler.idle();
    }
    expect(fake.maxInFlight).toBeLessThanOrEqual(2);
  });

  it('the claim re-checks the slot limit under its lock: a tick that counted the running trials too early cannot overshoot', async () => {
    const limit = scheduler.opts.maxConcurrent;
    fake.closeGate();
    await fx.experiment({ configIds: [cfgA, cfgB], taskIds: ['sce-31-slow', 'sce-32-slow'] }); // 4 pending trials
    expect(await scheduler.tick()).toBe(2);
    await waitFor(() => fake.inFlight === 2, 5000, '2 worker calls in flight');

    // tick() reads maxConcurrent once, before its claims: make that stale read see 50 free slots, as a tick does whose count
    // was taken before the other caller's claims committed. The claim reads it again, under the lock, and must refuse.
    let reads = 0;
    Object.defineProperty(scheduler.opts, 'maxConcurrent', { configurable: true, enumerable: true, get: () => (reads++ === 0 ? limit + 50 : limit) });
    try {
      expect(await scheduler.tick()).toBe(0);
    } finally {
      Object.defineProperty(scheduler.opts, 'maxConcurrent', { configurable: true, enumerable: true, writable: true, value: limit });
    }
    expect(await prisma.trial.count({ where: { status: 'running' } })).toBe(limit);
    expect(fake.inFlight).toBe(2);
  });

  it('a paused experiment is skipped, and so is a draft', async () => {
    const paused = await fx.experiment({ configIds: [cfgA], taskIds: ['sce-01-ok'], pauseReason: 'by hand' });
    const draft = await fx.experiment({ configIds: [cfgA], taskIds: ['sce-02-ok'], status: 'draft' });
    for (let i = 0; i < 3; i++) expect(await round()).toBe(0);
    expect(fake.runs).toHaveLength(0);
    expect((await trial(paused.trialIds[0])).status).toBe('pending');
    expect((await trial(draft.trialIds[0])).status).toBe('pending');
  });

  it('a spec that cannot be built (memory fixture gone) ends config_invalid without a retry or a worker call', async () => {
    const seeded = await fx.config(base, 'seeded', { memory: { mode: 'seeded', fixture: 'no-such-fixture', fixture_hash: 'deadbeef' } });
    const ex = await fx.experiment({ configIds: [seeded], taskIds: ['sce-01-ok'] });
    await runUntil(ex.id, (s) => s === 'partial');
    const t = await trial(ex.trialIds[0]);
    expect(t.status).toBe('errored');
    expect(t.errorClass).toBe('config_invalid');
    expect(t.errorMessage).toMatch(/memory fixture no-such-fixture@deadbeef is no longer stored/);
    expect(t.attemptCount).toBe(1);
    expect(t.attempts).toHaveLength(1);
    expect(fake.runs).toHaveLength(0);
  });

  it('runNow dispatches with no retry (a crash is terminal at once) and runs a paused experiment', async () => {
    const ex = await fx.experiment({ configIds: [cfgA], taskIds: ['sce-11-crash'], status: 'running', pauseReason: 'by hand' });
    await scheduler.runNow(ex.trialIds[0]);
    const t = await trial(ex.trialIds[0]);
    expect(t.status).toBe('errored');
    expect(t.errorClass).toBe('worker_crash');
    expect(t.attemptCount).toBe(1);
    expect(await status(ex.id)).toBe('partial');
    await expect(scheduler.runNow(ex.trialIds[0])).rejects.toThrow(/not pending/);
  });

  it('runNow promotes a draft experiment to running and on to completed (the adhoc path)', async () => {
    const ex = await fx.experiment({ configIds: [cfgA], taskIds: ['sce-01-ok'], status: 'draft' });
    await scheduler.runNow(ex.trialIds[0]);
    expect((await trial(ex.trialIds[0])).status).toBe('done');
    const e = await prisma.experiment.findUniqueOrThrow({ where: { id: ex.id } });
    expect(e.status).toBe('completed');
    expect(e.startedAt).not.toBeNull();
  });

  describe('dispatch catch-all: nothing between the claim and the settle leaves a trial running', () => {
    // {} is rejected by ingest() as an IngestError; null is a TypeError there. Both must end the trial through the normal path.
    it.each([
      ['{}', {}, /^worker result rejected: /],
      ['null', null, /^dispatch failed: /],
    ])('a worker answering %s: tick path retries to 3 attempts then errors worker_crash, with every attempt closed', async (_label, answer, message) => {
      const call = jest.spyOn(app.get(WorkerClient), 'runTrial').mockResolvedValue(answer as never);
      try {
        const ex = await fx.experiment({ configIds: [cfgA], taskIds: ['sce-01-ok'] });
        const id = ex.trialIds[0];
        expect(await round()).toBe(1);
        let t = await trial(id);
        expect(t).toMatchObject({ status: 'pending', errorClass: 'worker_crash', attemptCount: 1 });
        expect(t.errorMessage).toMatch(message);
        expect(t.attempts.map((a) => [a.result, a.endedAt !== null])).toEqual([['errored', true]]);

        advance(31_000);
        expect(await round()).toBe(1);
        advance(61_000);
        expect(await round()).toBe(1);
        t = await trial(id);
        expect(t).toMatchObject({ status: 'errored', errorClass: 'worker_crash', attemptCount: 3 });
        expect(t.attempts.map((a) => a.result)).toEqual(['errored', 'errored', 'errored']);
        expect(t.attempts.every((a) => a.endedAt !== null)).toBe(true);
        expect(await status(ex.id)).toBe('partial');
        expect(call).toHaveBeenCalledTimes(3);
      } finally {
        call.mockRestore();
      }
    });

    it.each([
      ['{}', {}, /^worker result rejected: /],
      ['null', null, /^dispatch failed: /],
    ])('a worker answering %s: the runNow path ends the trial errored at once', async (_label, answer, message) => {
      const call = jest.spyOn(app.get(WorkerClient), 'runTrial').mockResolvedValue(answer as never);
      try {
        const ex = await fx.experiment({ configIds: [cfgA], taskIds: ['sce-01-ok'], status: 'draft' });
        await scheduler.runNow(ex.trialIds[0]);
        const t = await trial(ex.trialIds[0]);
        expect(t).toMatchObject({ status: 'errored', errorClass: 'worker_crash', attemptCount: 1 });
        expect(t.errorMessage).toMatch(message);
        expect(t.attempts.map((a) => a.result)).toEqual(['errored']);
        expect(await status(ex.id)).toBe('partial');
      } finally {
        call.mockRestore();
      }
    });

    it('a database error while the spec is built is a worker_crash "dispatch failed", not a stuck running trial', async () => {
      const boom = jest.spyOn(prisma.task, 'findUnique').mockRejectedValueOnce(new Error('connection reset') as never);
      try {
        const ex = await fx.experiment({ configIds: [cfgA], taskIds: ['sce-01-ok'], status: 'draft' });
        await scheduler.runNow(ex.trialIds[0]);
        const t = await trial(ex.trialIds[0]);
        expect(t).toMatchObject({ status: 'errored', errorClass: 'worker_crash', errorMessage: 'dispatch failed: connection reset' });
        expect(t.attempts.map((a) => a.result)).toEqual(['errored']);
        expect(fake.runs).toHaveLength(0);
      } finally {
        boom.mockRestore();
      }
    });
  });

  it('a cancel committed between the claim and the worker call: the fake never receives /trials/run, nothing is written', async () => {
    const ex = await fx.experiment({ configIds: [cfgA], taskIds: ['sce-01-ok'] });
    const id = ex.trialIds[0];
    const original = prisma.task.findUnique.bind(prisma.task);
    // buildSpec reads the task after the claim and before the call: cancel exactly in that window
    const spy = jest.spyOn(prisma.task, 'findUnique').mockImplementation((async (args: never) => {
      await prisma.trial.update({ where: { id }, data: { status: 'cancelled', errorClass: 'cancelled', errorMessage: 'cancelled with the experiment' } });
      await prisma.trialAttempt.updateMany({ where: { trialId: id, result: null }, data: { result: 'cancelled', endedAt: new Date() } });
      return original(args);
    }) as never);
    try {
      expect(await scheduler.tick()).toBe(1);
      await scheduler.idle();
    } finally {
      spy.mockRestore();
    }
    expect(fake.runs).toHaveLength(0);
    const t = await trial(id);
    expect(t.status).toBe('cancelled');
    expect(t.attempts.map((a) => a.result)).toEqual(['cancelled']);
    expect(await prisma.trace.count({ where: { trialId: id } })).toBe(0);
    expect(await prisma.graderResult.count({ where: { trialId: id } })).toBe(0);
  });

  it('an experiment paused by the breaker while its last trial is in flight ends partial with pause_reason cleared', async () => {
    await fx.tasks(['scc-01-slow', ...['01', '02', '03', '04', '05'].map((n) => `scd-${n}-400`)]); // the slow one sorts first
    fake.closeGate();
    const ex = await fx.experiment({
      configIds: [cfgA],
      taskIds: ['scc-01-slow', ...['01', '02', '03', '04', '05'].map((n) => `scd-${n}-400`)],
    });
    await waitFor(
      async () => {
        await scheduler.tick();
        return (await prisma.experiment.findUniqueOrThrow({ where: { id: ex.id } })).pauseReason !== null;
      },
      10_000,
      'the circuit breaker pause',
    );
    expect(await status(ex.id)).toBe('running');
    expect(fake.inFlight).toBe(1); // the slow trial is still out

    fake.openGate();
    await scheduler.idle();
    const e = await prisma.experiment.findUniqueOrThrow({ where: { id: ex.id } });
    expect(e.status).toBe('partial');
    expect(e.pauseReason).toBeNull();
    expect(e.finishedAt).not.toBeNull();
    const rows = await trials(ex.id);
    expect(rows.filter((t) => t.status === 'errored')).toHaveLength(5);
    expect(rows.filter((t) => t.status === 'done')).toHaveLength(1);
  });
});
