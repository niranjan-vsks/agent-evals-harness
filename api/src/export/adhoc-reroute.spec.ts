/**
 * POST /trials/adhoc after the reroute through Scheduler.runNow: what must fail BEFORE any row exists still answers 409 and
 * leaves no experiment behind (D-5, the judge model). The rest of the behaviour is pinned by src/trials/adhoc.spec.ts.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CompareFixtures, JUDGE_GRADER } from '../../test/compare-fixtures';
import { Fixtures } from '../../test/helpers';
import { PrismaService } from '../prisma/prisma.service';
import { Scheduler } from '../scheduler/scheduler';
import { createTestApp, FakeWorker } from '../test-support/app';
import { WorkerUnavailableError } from '../worker-client/worker-client';

describe('POST /trials/adhoc, rows before the scheduler', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: FakeWorker;
  let fx: Fixtures;
  let cf: CompareFixtures;
  let http: ReturnType<typeof request>;
  let seededGone: string;
  let plain: string;

  beforeAll(async () => {
    worker = new FakeWorker();
    ({ app, prisma } = await createTestApp(worker));
    http = request(app.getHttpServer());
    fx = new Fixtures(prisma);
    cf = new CompareFixtures(prisma, fx);
    const base = await fx.base();
    seededGone = await fx.config(base, 'seeded, fixture gone', { memory: { mode: 'seeded', fixture: 'gone-fixture', fixture_hash: 'f'.repeat(64) } });
    plain = await fx.config(base, 'plain');
    await cf.task('adr-01-ok', 'neutral_deterministic', [{ type: 'exact_match', expected: '8081' }]);
    await cf.task('adr-02-judge', 'neutral_judged', [JUDGE_GRADER]);
  });

  afterAll(async () => {
    await cf.cleanup();
    await app.close();
  });

  const adhocExperiments = () => prisma.experiment.count({ where: { name: { startsWith: 'adhoc-' } } });

  it('answers 409 for a memory fixture that is no longer stored, creates no experiment and never calls the worker', async () => {
    const before = await adhocExperiments();
    worker.runs = [];
    const res = await http.post('/trials/adhoc').send({ config_id: seededGone, task_id: 'adr-01-ok' });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('D-5');
    expect(await adhocExperiments()).toBe(before);
    expect(worker.runs).toHaveLength(0);
  });

  it('answers 409 when the judge model is not configured, and creates no experiment', async () => {
    const saved = process.env.JUDGE_MODEL_ID;
    process.env.JUDGE_MODEL_ID = 'no-such-judge';
    try {
      const before = await adhocExperiments();
      const res = await http.post('/trials/adhoc').send({ config_id: plain, task_id: 'adr-02-judge' });
      expect(res.status).toBe(409);
      expect(await adhocExperiments()).toBe(before);
    } finally {
      if (saved === undefined) delete process.env.JUDGE_MODEL_ID;
      else process.env.JUDGE_MODEL_ID = saved;
    }
  });

  it('an HTTP 429 from the worker is a terminal errored trial with class backpressure (retry is off for ad hoc), not worker_crash', async () => {
    const saved = worker.run;
    worker.runs = [];
    worker.run = () => {
      throw new WorkerUnavailableError('worker /trials/run answered HTTP 429: {"detail":"worker at capacity"}');
    };
    try {
      const res = await http.post('/trials/adhoc').send({ config_id: plain, task_id: 'adr-01-ok' });
      expect(res.status).toBe(201);
      const trial = res.body.trial;
      fx.track(trial.experiment_id);
      expect(trial).toMatchObject({ status: 'errored', error_class: 'backpressure', passed: null });
      expect(trial.error_message).toContain('answered HTTP 429');
      // terminal at once: 1 worker call, no requeue, the experiment status is derived from the errored trial
      expect(worker.runs).toHaveLength(1);
      const stored = await prisma.trial.findUniqueOrThrow({ where: { id: trial.id } });
      expect(stored).toMatchObject({ status: 'errored', errorClass: 'backpressure' });
      const experiment = await prisma.experiment.findUniqueOrThrow({ where: { id: trial.experiment_id } });
      expect(experiment.status).toBe('partial');
    } finally {
      worker.run = saved;
    }
  });

  it('creates the experiment as a draft with 1 pending trial and hands the trial to Scheduler.runNow; a storage failure surfaces as 500', async () => {
    const scheduler = app.get(Scheduler);
    const seen: unknown[] = [];
    const spy = jest.spyOn(scheduler, 'runNow').mockImplementation(async (trialId: string) => {
      const t = await prisma.trial.findUniqueOrThrow({ where: { id: trialId }, include: { experiment: { include: { configs: true, tasks: true } } } });
      seen.push({ status: t.experiment.status, trial: t.status, attemptCount: t.attemptCount, configs: t.experiment.configs.length, tasks: t.experiment.tasks.length });
      fx.track(t.experimentId);
      throw new Error('could not store the result');
    });
    try {
      const res = await http.post('/trials/adhoc').send({ config_id: plain, task_id: 'adr-01-ok' });
      expect(res.status).toBe(500);
      expect(seen).toEqual([{ status: 'draft', trial: 'pending', attemptCount: 0, configs: 1, tasks: 1 }]);
    } finally {
      spy.mockRestore();
    }
  });
});
