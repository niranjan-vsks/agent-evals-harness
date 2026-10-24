/**
 * P3 card section 8 scenarios (h), (i) and (j): the real Scheduler runs experiments against the HTTP fake worker, then
 * the compare and pilot endpoints are read over HTTP. Time moves through Scheduler.clock, as in scheduler.e2e.spec.ts.
 *
 * Loaded by src/compare/compare.e2e.spec.ts, because jest's rootDir is src.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Scheduler } from '../src/scheduler/scheduler';
import { CompareFixtures, EXACT_GRADER, JUDGE_GRADER, keysDeep } from './compare-fixtures';
import { FakeWorkerServer } from './fake-worker';
import { Fixtures } from './helpers';

describe('compare and pilot over experiments run by the real scheduler (P3 gate 1 h, i, j)', () => {
  const fake = new FakeWorkerServer();
  let app: INestApplication;
  let prisma: PrismaService;
  let scheduler: Scheduler;
  let fx: Fixtures;
  let cf: CompareFixtures;
  let cfgA: string;
  let cfgB: string;
  let offsetMs = 0;
  const saved = { workerUrl: process.env.WORKER_URL, heartbeat: process.env.SCHEDULER_HEARTBEAT_MS };
  const OK = ['cme-01-ok', 'cme-02-ok', 'cme-03-ok'];
  const JUDGED = 'cme-14-judge';

  beforeAll(async () => {
    await fake.start();
    process.env.WORKER_URL = fake.url;
    process.env.SCHEDULER_HEARTBEAT_MS = '50';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile(); // the real WorkerClient and Scheduler
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    scheduler = app.get(Scheduler);
    fx = new Fixtures(prisma);
    cf = new CompareFixtures(prisma, fx);
    const base = await fx.base();
    cfgA = await fx.config(base, 'config A');
    cfgB = await fx.config(base, 'config B');
    for (const id of [...OK, 'cme-04-crash']) await cf.task(id, 'neutral_deterministic', [EXACT_GRADER]);
    await cf.task(JUDGED, 'neutral_judged', [JUDGE_GRADER]);
  });

  afterAll(async () => {
    await cf.cleanup();
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
    const stray = await fx.isolate(); // running trials other specs left behind count against the limit
    scheduler.opts.maxConcurrent = 2 + stray;
  });

  afterEach(async () => {
    fake.openGate();
    await scheduler.idle();
    scheduler.clock = () => new Date();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);
  const status = async (id: string) => (await prisma.experiment.findUniqueOrThrow({ where: { id } })).status;
  /** 3 concurrent ticks, then wait for the dispatches to settle. */
  async function round(): Promise<void> {
    await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
    await scheduler.idle();
  }
  /** Rounds, moving the clock past every retry backoff (30 s, 60 s) between them, until the status is wanted. */
  async function runUntil(experimentId: string, wanted: string[], maxRounds = 40): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      if (wanted.includes(await status(experimentId))) return;
      await round();
      offsetMs += 65_000;
    }
    throw new Error(`experiment ${experimentId} did not reach ${wanted.join('|')}: ${await status(experimentId)}`);
  }

  it('(h) a -crash task errored after 3 attempts leaves the experiment partial; compare reports n_excluded 2 and reliability partial', async () => {
    const ex = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: [...OK, 'cme-04-crash'], nTrials: 1 });
    await runUntil(ex.id, ['partial', 'completed']);
    expect(await status(ex.id)).toBe('partial');

    const crashed = await prisma.trial.findMany({ where: { experimentId: ex.id, taskId: 'cme-04-crash' } });
    expect(crashed.map((t) => [t.status, t.attemptCount])).toEqual([
      ['errored', 3],
      ['errored', 3],
    ]);

    const { body } = await get(`/experiments/${ex.id}/compare`).expect(200);
    expect(body.n_excluded).toBe(2);
    expect(body.n_unfinished).toBe(0);
    expect(body.reliability).toBe('partial');
    expect(body.n_scored).toBe(6); // 3 ok tasks x 2 configs
    expect(body.unpaired_tasks.map((u: { task_id: string }) => u.task_id)).toEqual(['cme-04-crash']);
    expect(body.aggregate.p_a).toBe(1);
    expect(body.aggregate.p_b).toBe(1);
    expect(body.judge_policy_applied).toBe('trusted'); // no judged task in this set
  });

  it('(i) a judged task: excluded without a judge_validation row and listed, counted and trusted with kappa 0.8', async () => {
    const ex = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: [...OK, JUDGED], nTrials: 1 });
    await runUntil(ex.id, ['completed']);
    const judgedTrials = await prisma.trial.findMany({ where: { experimentId: ex.id, taskId: JUDGED } });
    expect(judgedTrials).toHaveLength(2);

    // The fake worker has no judge, so its graders are exact_match rows; no judge rows exist yet.
    const none = (await get(`/experiments/${ex.id}/compare`).expect(200)).body;
    expect(none.judge_policy_applied).toBe('excluded');
    expect(none.judge_excluded_tasks).toEqual([JUDGED]);
    expect(none.n_scored).toBe(6);

    // Tag the judged trials' grader rows as the judge's, as the worker's llm_judge grader would write them.
    const model = `cme-judge-${Date.now()}`;
    await prisma.$executeRaw`UPDATE grader_result SET grader_type = 'llm_judge'::grader_type, judge_model_id = ${model}, judge_prompt_hash = 'prompt-1'
      WHERE trial_id IN (${judgedTrials[0].id}, ${judgedTrials[1].id})`;

    const unvalidated = (await get(`/experiments/${ex.id}/compare`).expect(200)).body;
    expect(unvalidated.judge_policy_applied).toBe('excluded');
    expect(unvalidated.judge).toEqual({ model_id: model, prompt_hash: 'prompt-1', kappa: null, policy: 'excluded' });
    expect(unvalidated.judge_excluded_tasks).toEqual([JUDGED]);
    expect(unvalidated.n_scored).toBe(6);
    expect(unvalidated.per_task.find((r: { task_id: string }) => r.task_id === JUDGED).judge_excluded).toBe(true);

    await cf.validation({ modelId: model, promptHash: 'prompt-1', kappa: 0.8 });
    const trusted = (await get(`/experiments/${ex.id}/compare`).expect(200)).body;
    expect(trusted.judge_policy_applied).toBe('trusted');
    expect(trusted.judge).toEqual({ model_id: model, prompt_hash: 'prompt-1', kappa: 0.8, policy: 'trusted' });
    expect(trusted.judge_excluded_tasks).toEqual([]);
    expect(trusted.judge_confidence).toBeNull();
    expect(trusted.n_scored).toBe(8);
    expect(trusted.per_task.find((r: { task_id: string }) => r.task_id === JUDGED).judge_excluded).toBe(false);
    expect(trusted.reliability).toBe('complete');
  });

  it('(j) pilot has no delta, rate_a or rate_b at any depth: while running, when finished, and on a draft with no trials', async () => {
    const forbidden = ['delta', 'rate_a', 'rate_b'];
    const assertClean = (body: unknown) => {
      const keys = keysDeep(body);
      for (const k of forbidden) expect(keys.has(k)).toBe(false);
    };

    const ex = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: OK, nTrials: 2 });
    await round(); // a first batch is done, the rest pending: the experiment is running
    expect(await status(ex.id)).toBe('running');
    const running = (await get(`/experiments/${ex.id}/pilot`).expect(200)).body;
    assertClean(running);
    expect(running).toMatchObject({ experiment_id: ex.id, n_configs: 2, n_tasks: 3, n_pilot: 2 });

    await runUntil(ex.id, ['completed']);
    const finished = (await get(`/experiments/${ex.id}/pilot`).expect(200)).body;
    assertClean(finished);
    expect(finished.ready).toBe(true);
    expect(finished.n_cells_used).toBe(6);

    // The scan is not vacuous: the compare payload of the same experiment does carry a delta.
    const compared = (await get(`/experiments/${ex.id}/compare`).expect(200)).body;
    expect(keysDeep(compared).has('delta')).toBe(true);

    const created = await request(app.getHttpServer())
      .post('/experiments')
      .send({ name: 'cme draft', config_ids: [cfgA, cfgB], task_ids: OK, n_trials: 3, phase: 'pilot' })
      .expect(201);
    fx.experimentIds.push(created.body.id);
    expect(created.body.status).toBe('draft');
    const draft = (await get(`/experiments/${created.body.id}/pilot`).expect(200)).body;
    assertClean(draft);
    expect(draft.ready).toBe(false);
    expect(draft.n_pilot).toBe(3);
    expect(typeof draft.reason).toBe('string');
  });
});
