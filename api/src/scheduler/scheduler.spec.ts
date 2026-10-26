import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Fixtures, sleep, trialRowIsFree, waitFor, withExperimentLock } from '../../test/helpers';
import { PrismaService } from '../prisma/prisma.service';
import { doneResult } from '../test-support/app';
import { erroredResult, MAX_TRACE_BYTES } from '../trials/ingest';
import { TrialResult, TrialSpec } from '../worker-client/types';
import { WorkerClient, WorkerUnavailableError } from '../worker-client/worker-client';
import { BREAKER_THRESHOLD, Scheduler } from './scheduler';

/** An in-process worker: records the specs, answers per task id suffix, and can hold calls at a gate. */
class StubWorker {
  specs: TrialSpec[] = [];
  gate: Promise<void> | null = null;
  answer: (spec: TrialSpec) => TrialResult | Promise<TrialResult> = (spec) => {
    if (spec.task.id.endsWith('-400')) return { ...erroredResult('config_invalid', 'bad config'), trial_id: spec.trial_id, attempt: spec.attempt };
    return doneResult(spec);
  };
  async runTrial(spec: TrialSpec): Promise<TrialResult> {
    this.specs.push(spec);
    if (this.gate) await this.gate;
    return this.answer(spec);
  }
  hold(): () => void {
    let release!: () => void;
    this.gate = new Promise<void>((ok) => (release = ok));
    return () => {
      this.gate = null;
      release();
    };
  }
}

describe('Scheduler (database, in-process worker)', () => {
  let prisma: PrismaService;
  let fx: Fixtures;
  let base: Awaited<ReturnType<Fixtures['base']>>;
  let cfg: string;
  let worker: StubWorker;
  let scheduler: Scheduler;
  let offsetMs = 0;
  const env = { enabled: process.env.SCHEDULER_ENABLED, tick: process.env.SCHEDULER_TICK_MS };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    fx = new Fixtures(prisma);
    base = await fx.base();
    cfg = await fx.config(base, 'c');
    await fx.tasks([
      ...['01', '02', '03', '04', '05', '06'].map((n) => `scu-${n}-ok`),
      ...['11', '12', '13', '14', '15', '16'].map((n) => `scu-${n}-400`),
      'scu-13-mid-ok',
      'scu-21-big',
    ]);
    // 2 graders, so a result of 2 rows passes the grader-count check of ingest and reaches the database (see duplicateGraders)
    await fx.tasks(['scu-31-two-graders'], [{ type: 'exact_match', expected: '8081' }, { type: 'exact_match', expected: '8081' }]);
  });
  afterAll(async () => {
    await fx.cleanup();
    await prisma.$disconnect();
    for (const [k, v] of [
      ['SCHEDULER_ENABLED', env.enabled],
      ['SCHEDULER_TICK_MS', env.tick],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  beforeEach(async () => {
    worker = new StubWorker();
    scheduler = new Scheduler(prisma, worker as unknown as WorkerClient);
    offsetMs = 0;
    scheduler.clock = () => new Date(Date.now() + offsetMs);
    const stray = await fx.isolate();
    scheduler.opts.maxConcurrent = 2 + stray;
  });
  afterEach(async () => {
    worker.gate = null;
    await scheduler.idle();
    scheduler.onModuleDestroy();
    jest.restoreAllMocks();
  });

  const trial = (id: string) => prisma.trial.findUniqueOrThrow({ where: { id }, include: { attempts: { orderBy: { attemptNo: 'asc' } } } });
  const experiment = (id: string) => prisma.experiment.findUniqueOrThrow({ where: { id } });
  const exp = (taskIds: string[], over: Partial<Parameters<Fixtures['experiment']>[0]> = {}) => fx.experiment({ configIds: [cfg], taskIds, ...over });

  describe('claim', () => {
    it('many concurrent ticks claim a pending trial exactly once', async () => {
      const ex = await exp(['scu-01-ok']);
      const claimed = await Promise.all(Array.from({ length: 8 }, () => scheduler.tick()));
      await scheduler.idle();
      expect(claimed.reduce((a, b) => a + b, 0)).toBe(1);
      expect(worker.specs).toHaveLength(1);
      const t = await trial(ex.trialIds[0]);
      expect(t).toMatchObject({ status: 'done', attemptCount: 1 });
      expect(t.attempts).toHaveLength(1);
    });

    it('in flight: running, attempt_count 1, heartbeat set, an open attempt row, price rewritten, experiment promoted to running', async () => {
      const ex = await exp(['scu-01-ok']);
      const release = worker.hold();
      expect(await scheduler.tick()).toBe(1);
      await waitFor(() => worker.specs.length === 1, 5000, 'the worker call');
      const t = await trial(ex.trialIds[0]);
      expect(t).toMatchObject({
        status: 'running',
        attemptCount: 1,
        errorClass: null,
        errorMessage: null,
        priceSnapshot: { input_price_per_mtok: 1, output_price_per_mtok: 2, cached_input_price_per_mtok: 0.5 },
      });
      expect(t.startedAt).not.toBeNull();
      expect(t.heartbeatAt).not.toBeNull();
      expect(t.endedAt).toBeNull();
      expect(t.attempts).toHaveLength(1);
      expect(t.attempts[0]).toMatchObject({ attemptNo: 1, result: null, endedAt: null });
      const e = await experiment(ex.id);
      expect(e.status).toBe('running');
      expect(e.startedAt).not.toBeNull();
      expect(worker.specs[0]).toMatchObject({ attempt: 1, trial_id: ex.trialIds[0] });
      release();
      await scheduler.idle();
      expect((await experiment(ex.id)).status).toBe('completed');
    });

    it('claims in the order experiment created_at, trial_index, task_id, config position', async () => {
      scheduler.opts.maxConcurrent = 1 + (await prisma.trial.count({ where: { status: 'running' } }));
      const cfg2 = await fx.config(base, 'second');
      const first = await fx.experiment({ configIds: [cfg2, cfg], taskIds: ['scu-02-ok', 'scu-01-ok'], nTrials: 2 });
      const second = await exp(['scu-01-ok']);
      const order: string[] = [];
      for (let i = 0; i < 9; i++) {
        expect(await scheduler.tick()).toBe(1);
        await scheduler.idle();
        order.push(worker.specs[worker.specs.length - 1].trial_id);
      }
      const label = new Map<string, string>();
      for (const id of first.trialIds) {
        const t = await trial(id);
        label.set(id, `${t.trialIndex}:${t.taskId}:${t.configId === cfg2 ? 'pos0' : 'pos1'}`);
      }
      label.set(second.trialIds[0], 'second');
      expect(order.map((id) => label.get(id))).toEqual([
        '0:scu-01-ok:pos0',
        '0:scu-01-ok:pos1',
        '0:scu-02-ok:pos0',
        '0:scu-02-ok:pos1',
        '1:scu-01-ok:pos0',
        '1:scu-01-ok:pos1',
        '1:scu-02-ok:pos0',
        '1:scu-02-ok:pos1',
        'second',
      ]);
    });

    it('skips a trial that is still in its backoff and claims the due one behind it', async () => {
      const ex = await exp(['scu-01-ok', 'scu-02-ok']);
      await prisma.trial.update({ where: { id: ex.trialIds[0] }, data: { errorClass: 'worker_crash', attemptCount: 1, endedAt: scheduler.clock() } });
      scheduler.opts.maxConcurrent = 1 + (await prisma.trial.count({ where: { status: 'running' } }));
      expect(await scheduler.tick()).toBe(1);
      await scheduler.idle();
      expect(worker.specs.map((s) => s.trial_id)).toEqual([ex.trialIds[1]]);
      expect(await scheduler.tick()).toBe(0);
      offsetMs += 31_000;
      expect(await scheduler.tick()).toBe(1);
    });

    it('counts running trials of the whole database against the limit', async () => {
      const ex = await exp(['scu-01-ok']);
      const other = await exp(['scu-02-ok'], { status: 'running', pauseReason: 'parked' });
      await prisma.trial.update({ where: { id: other.trialIds[0] }, data: { status: 'running', attemptCount: 1, heartbeatAt: new Date() } });
      scheduler.opts.maxConcurrent = await prisma.trial.count({ where: { status: 'running' } });
      expect(await scheduler.tick()).toBe(0);
      scheduler.opts.maxConcurrent += 1;
      expect(await scheduler.tick()).toBe(1);
      await scheduler.idle();
      expect((await trial(ex.trialIds[0])).status).toBe('done');
    });

    it('only pending trials of queued or running, unpaused experiments are candidates', async () => {
      await exp(['scu-01-ok'], { status: 'draft' });
      await exp(['scu-02-ok'], { pauseReason: 'by hand' });
      await exp(['scu-03-ok'], { status: 'running', pauseReason: 'by hand' });
      expect(await scheduler.tick()).toBe(0);
      expect(worker.specs).toHaveLength(0);
    });
  });

  describe('dispatch outcomes', () => {
    it('a result the API cannot store is worker_crash "worker result rejected" and is retried', async () => {
      worker.answer = (spec) => {
        const r = doneResult(spec, { passed: true });
        r.grader_results[0].passed = false;
        return r;
      };
      const ex = await exp(['scu-01-ok']);
      await scheduler.tick();
      await scheduler.idle();
      const t = await trial(ex.trialIds[0]);
      expect(t).toMatchObject({ status: 'pending', errorClass: 'worker_crash', attemptCount: 1 });
      expect(t.errorMessage).toMatch(/^worker result rejected: D-14/);
    });

    it('an oversized trace is retried once, then errors', async () => {
      worker.answer = (spec) => {
        const r = doneResult(spec);
        r.trace!.events = [{ seq: 0, t_ms: 0, kind: 'message', content: 'x'.repeat(MAX_TRACE_BYTES + 10) }];
        return r;
      };
      const ex = await exp(['scu-21-big']);
      await scheduler.tick();
      await scheduler.idle();
      expect((await trial(ex.trialIds[0])).status).toBe('pending');
      offsetMs += 31_000;
      await scheduler.tick();
      await scheduler.idle();
      const t = await trial(ex.trialIds[0]);
      expect(t).toMatchObject({ status: 'errored', errorClass: 'worker_crash', attemptCount: 2 });
      expect(t.attempts).toHaveLength(2);
      // the rejected 5 MB trace is the thing the cap keeps out of the database: no attempt row carries it
      expect(t.attempts.map((a) => a.partialTrace)).toEqual([null, null]);
    });

    it('HTTP 429 from the worker is backpressure, a refused connection is worker_crash', async () => {
      const ex = await exp(['scu-01-ok', 'scu-02-ok']);
      worker.answer = (spec) => {
        throw spec.task.id === 'scu-01-ok'
          ? new WorkerUnavailableError('worker /trials/run answered HTTP 429: {"detail":"worker at capacity"}')
          : new WorkerUnavailableError('worker /trials/run: fetch failed');
      };
      await scheduler.tick();
      await scheduler.idle();
      expect(await trial(ex.trialIds[0])).toMatchObject({ status: 'pending', errorClass: 'backpressure', attemptCount: 0 });
      expect(await trial(ex.trialIds[1])).toMatchObject({ status: 'pending', errorClass: 'worker_crash', attemptCount: 1 });
    });
  });

  describe('a result that cannot be stored', () => {
    /** 2 grader rows with the same grader_index, for the 2-grader task: ingest accepts it, the unique key on grader_result does not. */
    const duplicateGraders = (spec: TrialSpec): TrialResult => {
      const r = doneResult(spec);
      r.grader_results = [r.grader_results[0], { ...r.grader_results[0] }];
      return r;
    };
    /** Lets the first n transactions through (the claim) and fails every later one. */
    function breakTransactionsAfter(n: number): void {
      const real = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>;
      let calls = 0;
      jest
        .spyOn(prisma, '$transaction')
        .mockImplementation(((...a: unknown[]) => (++calls > n ? Promise.reject(new Error('db is down')) : real(...a))) as never);
    }

    it('is settled as errored worker_crash through the retry routing: a tick requeues it', async () => {
      worker.answer = duplicateGraders;
      const ex = await exp(['scu-31-two-graders']);
      expect(await scheduler.tick()).toBe(1);
      await scheduler.idle();
      const t = await trial(ex.trialIds[0]);
      expect(t).toMatchObject({ status: 'pending', errorClass: 'worker_crash', attemptCount: 1 });
      expect(t.errorMessage).toMatch(/^could not store the worker result: /);
      expect(t.attempts).toHaveLength(1);
      expect(t.attempts[0]).toMatchObject({ result: 'errored', errorClass: 'worker_crash' });
      expect(await prisma.trace.count({ where: { trialId: t.id } })).toBe(0); // the failed settle rolled back whole
      expect(await prisma.graderResult.count({ where: { trialId: t.id } })).toBe(0);
    });

    it('runNow has no retry, so the trial is terminal at once and the caller is not told of an error', async () => {
      worker.answer = duplicateGraders;
      const ex = await exp(['scu-31-two-graders']);
      await scheduler.runNow(ex.trialIds[0]);
      const t = await trial(ex.trialIds[0]);
      expect(t).toMatchObject({ status: 'errored', errorClass: 'worker_crash' });
      expect(t.errorMessage).toMatch(/^could not store the worker result: /);
      expect((await experiment(ex.id)).status).toBe('partial');
    });

    it('when the error settle fails too, runNow rejects with the original error', async () => {
      const ex = await exp(['scu-01-ok']);
      breakTransactionsAfter(1);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await expect(scheduler.runNow(ex.trialIds[0])).rejects.toThrow('db is down');
      jest.restoreAllMocks();
      expect(await trial(ex.trialIds[0])).toMatchObject({ status: 'running' }); // left for orphan recovery
    });

    it('when the error settle fails too, a tick only logs: the process survives and idle() resolves', async () => {
      const ex = await exp(['scu-01-ok']);
      breakTransactionsAfter(1);
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await expect(scheduler.tick()).resolves.toBe(1);
      await expect(scheduler.idle()).resolves.toBeUndefined();
      expect(logged.mock.calls.map((c) => String(c[0])).some((m) => m.startsWith(`dispatch of trial ${ex.trialIds[0]} failed`))).toBe(true);
      jest.restoreAllMocks();
      expect(await trial(ex.trialIds[0])).toMatchObject({ status: 'running' });
    });

    it('the claim and the settle use the long transaction options (60 s, 10 s wait), like ExperimentsService', async () => {
      const real = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>;
      const seen: unknown[] = [];
      jest.spyOn(prisma, '$transaction').mockImplementation(((fn: unknown, opts: unknown) => {
        seen.push(opts);
        return real(fn, opts);
      }) as never);
      const ex = await exp(['scu-01-ok']);
      await scheduler.runNow(ex.trialIds[0]);
      expect(seen).toEqual([
        { timeout: 60_000, maxWait: 10_000 },
        { timeout: 60_000, maxWait: 10_000 },
      ]);
    });
  });

  describe('lock order: the experiment row first, then trials', () => {
    it('a claim waits on the experiment lock before it has touched the trial row', async () => {
      const ex = await exp(['scu-01-ok']);
      let ticking!: Promise<number>;
      await withExperimentLock(prisma, ex.id, async (tx) => {
        ticking = scheduler.tick(); // blocks in the claim
        await sleep(400);
        expect(await trialRowIsFree(tx, ex.trialIds[0])).toBe(true);
        expect((await trial(ex.trialIds[0])).status).toBe('pending');
      });
      expect(await ticking).toBe(1);
      await scheduler.idle();
      expect((await trial(ex.trialIds[0])).status).toBe('done');
    });

    it('a claim sees a cancel that committed after its candidate query, and claims nothing', async () => {
      const ex = await exp(['scu-01-ok']);
      let ticking!: Promise<number>;
      await withExperimentLock(prisma, ex.id, async (tx) => {
        ticking = scheduler.tick(); // its candidate list still shows the trial as pending in a queued experiment
        await sleep(400);
        await tx.$executeRaw`UPDATE trial SET status = 'cancelled'::trial_status, error_class = 'cancelled'::error_class WHERE experiment_id = ${ex.id}`;
        await tx.$executeRaw`UPDATE experiment SET status = 'cancelled'::experiment_status, finished_at = now() WHERE id = ${ex.id}`;
      });
      expect(await ticking).toBe(0);
      await scheduler.idle();
      expect(worker.specs).toHaveLength(0);
      expect((await trial(ex.trialIds[0])).status).toBe('cancelled');
    });

    it('a claim sees a pause that committed after its candidate query', async () => {
      const ex = await exp(['scu-01-ok']);
      let ticking!: Promise<number>;
      await withExperimentLock(prisma, ex.id, async (tx) => {
        ticking = scheduler.tick();
        await sleep(400);
        await tx.$executeRaw`UPDATE experiment SET pause_reason = 'paused meanwhile' WHERE id = ${ex.id}`;
      });
      expect(await ticking).toBe(0);
      expect(worker.specs).toHaveLength(0);
    });

    it('a claim sees the trial requeued with a backoff since its candidate query, and leaves it alone', async () => {
      const ex = await exp(['scu-01-ok']);
      let ticking!: Promise<number>;
      await withExperimentLock(prisma, ex.id, async (tx) => {
        ticking = scheduler.tick(); // the candidate row says: never failed, due at once
        await sleep(400);
        // another caller claimed it, it failed with rate_limited and went back to pending
        await tx.$executeRaw`UPDATE trial SET error_class = 'rate_limited'::error_class, attempt_count = 1, ended_at = now() WHERE id = ${ex.trialIds[0]}`;
      });
      expect(await ticking).toBe(0);
      expect(worker.specs).toHaveLength(0);
      expect(await trial(ex.trialIds[0])).toMatchObject({ status: 'pending', attemptCount: 1 });
    });
  });

  describe('circuit breaker', () => {
    const bad = ['11', '12', '13', '14', '15', '16'].map((n) => `scu-${n}-400`);

    it('the 5th error being the last trial leaves the experiment partial and NOT paused', async () => {
      scheduler.opts.maxConcurrent = 1 + (await prisma.trial.count({ where: { status: 'running' } }));
      const ex = await exp(bad.slice(0, 5));
      for (let i = 0; i < 6; i++) {
        await scheduler.tick();
        await scheduler.idle();
      }
      const e = await experiment(ex.id);
      expect(e.status).toBe('partial');
      expect(e.pauseReason).toBeNull();
      expect(worker.specs).toHaveLength(5);
    });

    async function drain(): Promise<void> {
      for (let i = 0; i < 30; i++) {
        const n = await scheduler.tick();
        await scheduler.idle();
        if (n === 0) return;
      }
    }

    it(`pauses at ${BREAKER_THRESHOLD} consecutive terminal errors and then dispatches nothing more`, async () => {
      scheduler.opts.maxConcurrent = 1 + (await prisma.trial.count({ where: { status: 'running' } }));
      const ex = await exp(bad);
      await drain();
      const e = await experiment(ex.id);
      expect(e.pauseReason).toBe('circuit breaker: 5 consecutive terminal errors (last: config_invalid: bad config)');
      expect(e.status).toBe('running');
      expect(worker.specs).toHaveLength(5);
      expect(await scheduler.tick()).toBe(0);
    });

    it('a done trial resets the count: 3 errors, 1 done, 3 errors never pause', async () => {
      scheduler.opts.maxConcurrent = 1 + (await prisma.trial.count({ where: { status: 'running' } }));
      // claim order is by task id: 11, 12, 13 (400), 13-mid (ok), 14, 15, 16 (400)
      const ex = await exp([...bad.slice(0, 3), 'scu-13-mid-ok', ...bad.slice(3)]);
      await drain();
      const e = await experiment(ex.id);
      expect(e.pauseReason).toBeNull();
      expect(e.status).toBe('partial');
      expect(worker.specs).toHaveLength(7);
    });

    it('resetBreaker lets the experiment collect another 5 before pausing again', async () => {
      scheduler.opts.maxConcurrent = 1 + (await prisma.trial.count({ where: { status: 'running' } }));
      const ex = await exp(bad);
      await drain();
      expect((await experiment(ex.id)).pauseReason).toMatch(/^circuit breaker/);
      scheduler.resetBreaker(ex.id);
      await prisma.experiment.update({ where: { id: ex.id }, data: { pauseReason: null } });
      await drain();
      expect((await trial(ex.trialIds[5])).status).toBe('errored'); // the 6th ran; 1 error after the reset
      expect((await experiment(ex.id)).pauseReason).toBeNull();
      expect((await experiment(ex.id)).status).toBe('partial');
    });

    it('does not overwrite a pause reason that is already set', async () => {
      scheduler.opts.maxConcurrent = 1 + (await prisma.trial.count({ where: { status: 'running' } }));
      const ex = await exp(bad.slice(0, 6)); // the 6th stays pending, so the experiment is not over (a finished one drops its pause_reason)
      const release = worker.hold();
      await scheduler.tick();
      await waitFor(() => worker.specs.length === 1, 5000, 'the worker call');
      await prisma.experiment.update({ where: { id: ex.id }, data: { pauseReason: 'set by hand' } });
      release();
      await scheduler.idle();
      // the paused experiment dispatches nothing, so 1 error only; push 4 more through runNow (it ignores the pause)
      for (const id of ex.trialIds.slice(1, 5)) await scheduler.runNow(id);
      expect((await experiment(ex.id)).pauseReason).toBe('set by hand');
    });
  });

  describe('orphans', () => {
    async function runningTrial(timeoutSeconds: number, heartbeatAgeMs: number) {
      const c = await fx.config(base, `t${timeoutSeconds}`, { timeout_seconds: timeoutSeconds });
      const ex = await fx.experiment({ configIds: [c], taskIds: ['scu-01-ok'], status: 'running' });
      const hb = new Date(Date.now() - heartbeatAgeMs);
      await prisma.trial.update({ where: { id: ex.trialIds[0] }, data: { status: 'running', attemptCount: 1, startedAt: hb, heartbeatAt: hb } });
      await prisma.trialAttempt.create({ data: { id: `o-${ex.trialIds[0]}`, trialId: ex.trialIds[0], attemptNo: 1, startedAt: hb } });
      return ex;
    }

    it('the threshold is timeout_seconds + 180 s of the trial config', async () => {
      const shortCfg = await runningTrial(10, 200_000); // 200 s old, limit 190 s: stale
      const longCfg = await runningTrial(300, 200_000); // 200 s old, limit 480 s: alive
      await scheduler.recoverOrphans();
      expect((await trial(shortCfg.trialIds[0])).status).toBe('pending');
      expect((await trial(longCfg.trialIds[0])).status).toBe('running');
    });

    it('does not touch a trial whose dispatch is in flight in this process', async () => {
      const ex = await exp(['scu-01-ok']);
      const release = worker.hold();
      await scheduler.tick();
      await waitFor(() => worker.specs.length === 1, 5000, 'the worker call');
      await prisma.trial.update({ where: { id: ex.trialIds[0] }, data: { heartbeatAt: new Date(Date.now() - 3_600_000) } });
      expect(await scheduler.recoverOrphans()).toBe(0);
      expect((await trial(ex.trialIds[0])).status).toBe('running');
      release();
      await scheduler.idle();
      expect((await trial(ex.trialIds[0])).status).toBe('done');
    });

    it('the recovery transaction uses the long transaction options', async () => {
      const real = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>;
      const seen: unknown[] = [];
      jest.spyOn(prisma, '$transaction').mockImplementation(((fn: unknown, opts: unknown) => {
        seen.push(opts);
        return real(fn, opts);
      }) as never);
      const stale = await runningTrial(10, 200_000);
      await scheduler.recoverOrphans();
      expect((await trial(stale.trialIds[0])).status).toBe('pending');
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen.every((o) => JSON.stringify(o) === JSON.stringify({ timeout: 60_000, maxWait: 10_000 }))).toBe(true);
    });

    it('tells the worker to cancel the trials it re-queued or errored, once and after the settle, and only those', async () => {
      const requeued = await runningTrial(10, 200_000);
      const alive = await runningTrial(300, 200_000);
      const out = await fx.experiment({ configIds: [cfg], taskIds: ['scu-02-ok'], status: 'running' });
      const old = new Date(Date.now() - 3_600_000);
      await prisma.trial.update({ where: { id: out.trialIds[0] }, data: { status: 'running', attemptCount: 3, startedAt: old, heartbeatAt: old } });
      const seen: string[] = [];
      const told = jest.spyOn(scheduler, 'cancelOnWorker').mockImplementation(async (ids: string[]) => {
        for (const id of ids) seen.push((await trial(id)).status); // the settle has committed by now
      });
      expect(await scheduler.recoverOrphans()).toBe(2);
      expect(told).toHaveBeenCalledTimes(1);
      expect([...told.mock.calls[0][0]].sort()).toEqual([requeued.trialIds[0], out.trialIds[0]].sort());
      expect(told.mock.calls[0][0]).not.toContain(alive.trialIds[0]);
      expect(seen.sort()).toEqual(['errored', 'pending']);
    });

    it('does not call the worker when nothing was recovered, and a failing cancel does not fail the recovery', async () => {
      const told = jest.spyOn(scheduler, 'cancelOnWorker').mockRejectedValue(new Error('worker down'));
      await runningTrial(300, 200_000); // alive
      expect(await scheduler.recoverOrphans()).toBe(0);
      expect(told).not.toHaveBeenCalled();
      const stale = await runningTrial(10, 200_000);
      expect(await scheduler.recoverOrphans()).toBeGreaterThanOrEqual(1);
      expect(told).toHaveBeenCalledTimes(1);
      expect((await trial(stale.trialIds[0])).status).toBe('pending');
    });

    it('a recovered orphan counts towards the breaker', async () => {
      // a 6th trial stays pending: when the 5th error is also the last trial the experiment is partial and cannot be paused
      const taskIds = ['scu-01-ok', 'scu-02-ok', 'scu-03-ok', 'scu-04-ok', 'scu-05-ok', 'scu-06-ok'];
      const ex = await fx.experiment({ configIds: [cfg], taskIds, status: 'running' });
      const old = new Date(Date.now() - 3_600_000);
      for (const id of ex.trialIds.slice(0, 5)) {
        await prisma.trial.update({ where: { id }, data: { status: 'running', attemptCount: 3, startedAt: old, heartbeatAt: old } });
      }
      await scheduler.recoverOrphans();
      expect((await experiment(ex.id)).pauseReason).toMatch(/^circuit breaker: 5 consecutive terminal errors \(last: orphaned:/);
    });
  });

  describe('runNow', () => {
    it('rejects an unknown trial and a cancelled experiment', async () => {
      await expect(scheduler.runNow('nope')).rejects.toBeInstanceOf(NotFoundException);
      const ex = await exp(['scu-01-ok']);
      await prisma.experiment.update({ where: { id: ex.id }, data: { status: 'cancelled' } });
      await expect(scheduler.runNow(ex.trialIds[0])).rejects.toBeInstanceOf(ConflictException);
    });

    it('ignores the slot limit', async () => {
      const ex = await exp(['scu-01-ok']);
      scheduler.opts.maxConcurrent = 0;
      await scheduler.runNow(ex.trialIds[0]);
      expect((await trial(ex.trialIds[0])).status).toBe('done');
    });
  });

  describe('timers and kick', () => {
    it('start only when SCHEDULER_ENABLED=1, or unset outside NODE_ENV=test', () => {
      expect(Scheduler.timersEnabled({ SCHEDULER_ENABLED: '1', NODE_ENV: 'test' })).toBe(true);
      expect(Scheduler.timersEnabled({ NODE_ENV: 'production' })).toBe(true);
      expect(Scheduler.timersEnabled({})).toBe(true);
      expect(Scheduler.timersEnabled({ NODE_ENV: 'test' })).toBe(false);
      expect(Scheduler.timersEnabled({ SCHEDULER_ENABLED: '0', NODE_ENV: 'production' })).toBe(false);
    });

    it('stay off under jest, and a bootstrap then starts nothing', async () => {
      delete process.env.SCHEDULER_ENABLED;
      await scheduler.onApplicationBootstrap();
      expect(scheduler.timersRunning).toBe(false);
    });

    it('when enabled: recover orphans first, then tick on the interval; destroy stops them', async () => {
      process.env.SCHEDULER_ENABLED = '1';
      process.env.SCHEDULER_TICK_MS = '20';
      const timed = new Scheduler(prisma, worker as unknown as WorkerClient);
      timed.opts.maxConcurrent = scheduler.opts.maxConcurrent;
      const orphan = await fx.experiment({ configIds: [cfg], taskIds: ['scu-02-ok'], status: 'running' });
      const old = new Date(Date.now() - 3_600_000);
      await prisma.trial.update({ where: { id: orphan.trialIds[0] }, data: { status: 'running', attemptCount: 3, startedAt: old, heartbeatAt: old } });
      const ex = await exp(['scu-01-ok']);

      await timed.onApplicationBootstrap();
      expect(timed.timersRunning).toBe(true);
      expect((await trial(orphan.trialIds[0])).status).toBe('errored'); // boot recovery ran before the first tick
      await waitFor(async () => (await trial(ex.trialIds[0])).status === 'done', 5000, 'the interval tick');
      timed.onModuleDestroy();
      expect(timed.timersRunning).toBe(false);
      await timed.idle();
      delete process.env.SCHEDULER_ENABLED;
    });

    it('the interval tick skips a run while the previous one is still going', async () => {
      let finish!: () => void;
      const tick = jest.spyOn(scheduler, 'tick').mockImplementation(() => new Promise<number>((ok) => (finish = () => ok(0))));
      const a = scheduler.intervalTick(false);
      await scheduler.intervalTick(false); // returns at once
      expect(tick).toHaveBeenCalledTimes(1);
      finish();
      await a;
      const b = scheduler.intervalTick(false);
      expect(tick).toHaveBeenCalledTimes(2);
      finish();
      await b;
    });

    it('a kick during a tick asks for one more pass instead of overlapping', async () => {
      const finishers: (() => void)[] = [];
      const tick = jest.spyOn(scheduler, 'tick').mockImplementation(() => new Promise<number>((ok) => finishers.push(() => ok(0))));
      const a = scheduler.intervalTick(false);
      await scheduler.intervalTick(true);
      await scheduler.intervalTick(true);
      expect(tick).toHaveBeenCalledTimes(1);
      finishers[0]();
      await waitFor(() => finishers.length === 2, 2000, 'the second pass');
      finishers[1]();
      await a;
      expect(tick).toHaveBeenCalledTimes(2);
    });

    it('the orphan interval skips a run while the previous one is still going', async () => {
      let finish!: () => void;
      const rec = jest.spyOn(scheduler, 'recoverOrphans').mockImplementation(() => new Promise<number>((ok) => (finish = () => ok(0))));
      const a = scheduler.intervalOrphans();
      await scheduler.intervalOrphans();
      expect(rec).toHaveBeenCalledTimes(1);
      finish();
      await a;
    });

    it('kick() runs a tick on setImmediate', async () => {
      const ex = await exp(['scu-01-ok']);
      scheduler.kick();
      await waitFor(async () => (await trial(ex.trialIds[0])).status === 'done', 5000, 'the kicked tick');
    });

    it('kick() returns at once, and a failing tick is logged instead of thrown or left unhandled', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const tick = jest.spyOn(scheduler, 'tick').mockRejectedValue(new Error('database is down'));
      expect(() => scheduler.kick()).not.toThrow();
      expect(tick).not.toHaveBeenCalled(); // deferred to setImmediate, not run inside kick()
      await waitFor(() => logged.mock.calls.length > 0, 2000, 'the error log');
      expect(String(logged.mock.calls[0][0])).toMatch(/tick failed: database is down/);
      expect(tick).toHaveBeenCalledTimes(1);
    });

    describe('heartbeat timers', () => {
      const heartbeats = () => jest.spyOn(scheduler as unknown as { heartbeat: (id: string) => Promise<void> }, 'heartbeat');

      it('beat while the worker call is in flight and stop once the dispatch has ended', async () => {
        scheduler.opts.heartbeatMs = 15;
        const beat = heartbeats();
        const ex = await exp(['scu-01-ok']);
        const release = worker.hold();
        await scheduler.tick();
        const first = (await trial(ex.trialIds[0])).heartbeatAt!;
        await waitFor(() => beat.mock.calls.length >= 3, 5000, '3 heartbeats');
        await waitFor(async () => (await trial(ex.trialIds[0])).heartbeatAt!.getTime() > first.getTime(), 5000, 'heartbeat_at to move');
        release();
        await scheduler.idle();
        await sleep(50); // a beat that was already running may still be finishing
        const n = beat.mock.calls.length;
        await sleep(200);
        expect(beat.mock.calls.length).toBe(n);
        const done = await trial(ex.trialIds[0]);
        expect(done.status).toBe('done');
        await sleep(100);
        expect((await trial(ex.trialIds[0])).heartbeatAt).toEqual(done.heartbeatAt); // and heartbeat_at no longer moves
      });

      it('onModuleDestroy stops the beat of a dispatch that is still in flight', async () => {
        scheduler.opts.heartbeatMs = 15;
        const beat = heartbeats();
        const ex = await exp(['scu-01-ok']);
        const release = worker.hold();
        await scheduler.tick();
        await waitFor(() => beat.mock.calls.length >= 2, 5000, '2 heartbeats');
        scheduler.onModuleDestroy();
        await sleep(50);
        const n = beat.mock.calls.length;
        await sleep(200);
        expect(beat.mock.calls.length).toBe(n);
        expect((await trial(ex.trialIds[0])).status).toBe('running');
        release();
        await scheduler.idle();
      });
    });

    it('idle() resolves at once when nothing is in flight', async () => {
      await expect(scheduler.idle()).resolves.toBeUndefined();
    });
  });
});
