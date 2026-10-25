/**
 * Exports after a real run, the shape of P3 gate 4 against the fake: 2 configs x 3 tasks x N=2 = 12 trials, created and
 * started over HTTP, driven to completed by the REAL Scheduler against the HTTP fake worker (the real WorkerClient), then
 * export.csv, compare.csv and export.json read over HTTP. Also POST /trials/adhoc through the same scheduler.
 *
 * Loaded by src/export/export.e2e.spec.ts, because jest's rootDir is src.
 *
 * Tests share the one experiment and run in file order: the first export.json test is the one that sees an empty
 * comparison_run table for it.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { COMPARE_CSV_COLUMNS, EXPORT_CSV_COLUMNS } from '../src/export/service';
import { PrismaService } from '../src/prisma/prisma.service';
import { Scheduler } from '../src/scheduler/scheduler';
import { CompareFixtures, EXACT_GRADER } from './compare-fixtures';
import { csvObjects, parseCsv } from './csv-parse';
import { FakeWorkerServer } from './fake-worker';
import { Fixtures } from './helpers';

const NASTY_NAME = 'hermes "off", plain\nmemory';
const TASKS = ['exe-01-ok', 'exe-02-fail', 'exe-03-ok'];

describe('exports after a run through the real scheduler (P3 gate 4 shape)', () => {
  const fake = new FakeWorkerServer();
  let app: INestApplication;
  let prisma: PrismaService;
  let scheduler: Scheduler;
  let fx: Fixtures;
  let cf: CompareFixtures;
  let kickSpy: jest.SpyInstance;
  let cfgA: string;
  let cfgB: string;
  let experimentId: string;
  const saved = { workerUrl: process.env.WORKER_URL, heartbeat: process.env.SCHEDULER_HEARTBEAT_MS };

  const http = () => request(app.getHttpServer());
  const get = (path: string) => http().get(path);
  const runsOf = (id: string) => prisma.comparisonRun.findMany({ where: { experimentId: id }, orderBy: [{ computedAt: 'asc' }, { id: 'asc' }] });

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
    kickSpy = jest.spyOn(scheduler, 'kick').mockImplementation(() => undefined); // this spec drives tick() by hand

    const base = await fx.base();
    cfgA = await fx.config(base, NASTY_NAME);
    cfgB = await fx.config(base, 'hermes seeded');
    await cf.task(TASKS[0], 'neutral_deterministic', [EXACT_GRADER]);
    await cf.task(TASKS[1], 'honesty', [EXACT_GRADER]);
    await cf.task(TASKS[2], 'memory_dependent', [EXACT_GRADER]);

    const stray = await fx.isolate(); // other specs' queued work must not take our slots
    scheduler.opts.maxConcurrent = 2 + stray;

    const created = await http()
      .post('/experiments')
      .send({ name: 'export e2e', config_ids: [cfgA, cfgB], task_ids: TASKS, n_trials: 2, seed: 4242, axis: 'memory off vs seeded', hypothesis: 'H1: seeded wins' })
      .expect(201);
    experimentId = created.body.id;
    fx.track(experimentId);
    expect(created.body.status).toBe('draft');
    await http().post(`/experiments/${experimentId}/start`).expect(200);

    for (let i = 0; i < 40; i++) {
      const status = (await prisma.experiment.findUniqueOrThrow({ where: { id: experimentId } })).status;
      if (status === 'completed') break;
      await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
      await scheduler.idle();
    }
  });

  afterAll(async () => {
    kickSpy.mockRestore();
    fake.openGate();
    await scheduler.idle();
    await cf.cleanup();
    await app.close();
    await fake.stop();
    if (saved.workerUrl === undefined) delete process.env.WORKER_URL;
    else process.env.WORKER_URL = saved.workerUrl;
    if (saved.heartbeat === undefined) delete process.env.SCHEDULER_HEARTBEAT_MS;
    else process.env.SCHEDULER_HEARTBEAT_MS = saved.heartbeat;
  });

  it('drove 2 configs x 3 tasks x N=2 to completed: 12 trials, 1 attempt each, 12 worker calls', async () => {
    const exp = await prisma.experiment.findUniqueOrThrow({ where: { id: experimentId } });
    expect(exp.status).toBe('completed');
    const trials = await prisma.trial.findMany({ where: { experimentId }, include: { attempts: true } });
    expect(trials).toHaveLength(12);
    expect(trials.every((t) => t.status === 'done' && t.attempts.length === 1)).toBe(true);
    expect(fake.runs).toHaveLength(12);
  });

  it('export.json: 12 trials with grader_results; exactly 1 stored comparison_run after the first export, equal to GET compare', async () => {
    expect(await runsOf(experimentId)).toHaveLength(0);

    const res = await get(`/experiments/${experimentId}/export.json`).expect(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="experiment-[^"]+\.json"$/);
    const body = res.body;
    expect(Object.keys(body)).toEqual(['experiment', 'configs', 'tasks', 'trials', 'comparison_runs', 'comparison_run_id']);
    expect(body.experiment).toMatchObject({ id: experimentId, status: 'completed', n_trials: 2, seed: 4242, hypothesis: 'H1: seeded wins' });
    expect(body.configs.map((c: { name: string; position: number }) => [c.name, c.position])).toEqual([
      [NASTY_NAME, 0],
      ['hermes seeded', 1],
    ]);
    expect(body.tasks.map((t: { task_id: string }) => t.task_id)).toEqual(TASKS);
    expect(body.trials).toHaveLength(12);
    for (const t of body.trials) {
      expect(t.status).toBe('done');
      expect(t.grader_results).toHaveLength(1);
      expect(t.grader_results[0]).toMatchObject({ grader_index: 0, grader_type: 'exact_match', passed: t.passed });
      expect(Object.keys(t)).not.toContain('trace');
    }
    expect(body.trials.filter((t: { task_id: string }) => t.task_id === 'exe-02-fail').every((t: { passed: boolean }) => t.passed === false)).toBe(true);

    expect(body.comparison_runs).toHaveLength(1);
    const run = body.comparison_runs[0];
    expect(run).toMatchObject({ config_a_id: cfgA, config_b_id: cfgB, seed: 4242, resamples: 10000, judge_policy_applied: 'trusted' });
    const compared = (await get(`/experiments/${experimentId}/compare`).expect(200)).body;
    expect(run.result).toEqual(compared); // reproducible from the row
    expect(body.comparison_run_id).toBe(run.id);
    expect(await runsOf(experimentId)).toHaveLength(1); // GET compare without persist stores nothing
  });

  it('a second export.json of the unchanged experiment reuses the comparison_run row: same id, same result', async () => {
    const before = await runsOf(experimentId);
    const body = (await get(`/experiments/${experimentId}/export.json`).expect(200)).body;
    expect(body.comparison_runs).toHaveLength(before.length);
    expect(body.comparison_run_id).toBe(before[before.length - 1].id);
    expect(await runsOf(experimentId)).toHaveLength(before.length);
  });

  it('export.json leaves traces out by default and includes every trial\'s trace with ?traces=1', async () => {
    const plain = await get(`/experiments/${experimentId}/export.json`).expect(200);
    expect(plain.text).not.toContain('FINAL: 8081');
    expect(plain.text).not.toContain('"events"');

    const traced = (await get(`/experiments/${experimentId}/export.json?traces=1`).expect(200)).body;
    expect(traced.trials).toHaveLength(12);
    for (const t of traced.trials) {
      expect(t.trace).toMatchObject({ trial_id: t.id, final_response: 'FINAL: 8081' });
      expect(t.trace.events).toHaveLength(7);
    }
  });

  it('export.csv: the exact header line, 12 rows ordered by config, task and index; the awkward config name round-trips', async () => {
    const res = await get(`/experiments/${experimentId}/export.csv`).expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.text.split('\n')[0]).toBe(
      'trial_id,config_id,config_name,task_id,task_category,trial_index,status,passed,exit_reason,steps,input_tokens,output_tokens,cost_usd,latency_ms,rate_limit_events,error_class,failure_category',
    );
    expect(res.text.split('\n')[0]).toBe(EXPORT_CSV_COLUMNS.join(','));
    const records = parseCsv(res.text);
    expect(records).toHaveLength(13);
    expect(records.every((r) => r.length === EXPORT_CSV_COLUMNS.length)).toBe(true);

    const rows = csvObjects(res.text);
    expect(rows.map((r) => `${r.config_id === cfgA ? 'A' : 'B'}/${r.task_id}/${r.trial_index}`)).toEqual(
      ['A', 'B'].flatMap((c) => TASKS.flatMap((t) => [0, 1].map((i) => `${c}/${t}/${i}`))),
    );
    expect(rows.filter((r) => r.config_id === cfgA).every((r) => r.config_name === NASTY_NAME)).toBe(true);
    expect(rows.filter((r) => r.config_id === cfgB).every((r) => r.config_name === 'hermes seeded')).toBe(true);
    expect(rows[0]).toMatchObject({ task_category: 'neutral_deterministic', status: 'done', passed: 'true', exit_reason: 'completed', steps: '2', input_tokens: '3000', output_tokens: '40', rate_limit_events: '0', error_class: '' });
    expect(rows.filter((r) => r.task_id === 'exe-02-fail').map((r) => r.passed)).toEqual(['false', 'false', 'false', 'false']);
    // The real scheduler path (ingest, settle) stored a category for every failed trial and none for a pass.
    expect(rows.filter((r) => r.task_id === 'exe-02-fail').map((r) => r.failure_category)).toEqual(['wrong_answer', 'wrong_answer', 'wrong_answer', 'wrong_answer']);
    expect(rows.filter((r) => r.passed === 'true').every((r) => r.failure_category === '')).toBe(true);
    expect(rows.find((r) => r.task_id === 'exe-03-ok')!.task_category).toBe('memory_dependent');
    // The cost is the trial's own stored decimal: 3000 in x 1 + 40 out x 2 per million tokens.
    const db = await prisma.trial.findUniqueOrThrow({ where: { id: rows[0].trial_id } });
    expect(rows[0].cost_usd).toBe(db.costUsd!.toFixed());
    expect(Number(rows[0].cost_usd)).toBeCloseTo(0.00308, 6);
  });

  it('compare.csv: the exact header, 3 task rows and a final __aggregate__ row, matching the compare payload', async () => {
    const before = (await runsOf(experimentId)).length; // export.json already stored this unchanged experiment's comparison
    const res = await get(`/experiments/${experimentId}/compare.csv?a=${cfgA}&b=${cfgB}`).expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.text.split('\n')[0]).toBe('task_id,category,n_a,n_b,rate_a,rate_b,delta,ci_low,ci_high,verdict');
    const records = parseCsv(res.text);
    expect(records[0]).toEqual([...COMPARE_CSV_COLUMNS]);
    expect(records).toHaveLength(5);
    expect(records.slice(1, 4).map((r) => r[0])).toEqual(TASKS);
    expect(records[4][0]).toBe('__aggregate__');

    const rows = csvObjects(res.text);
    const payload = (await get(`/experiments/${experimentId}/compare`).expect(200)).body;
    for (const t of payload.per_task) {
      const row = rows.find((r) => r.task_id === t.task_id)!;
      expect(row).toMatchObject({ category: t.category, n_a: String(t.n_a), n_b: String(t.n_b) });
      expect(Number(row.rate_a)).toBeCloseTo(t.rate_a, 12);
      expect(Number(row.rate_b)).toBeCloseTo(t.rate_b, 12);
      expect(Number(row.delta)).toBeCloseTo(t.delta, 12);
      expect(row.verdict).toBe(t.verdict);
    }
    const agg = rows[3];
    expect(agg).toMatchObject({ category: '', n_a: '6', n_b: '6', verdict: payload.aggregate.verdict });
    expect(Number(agg.n_a) + Number(agg.n_b)).toBe(payload.n_scored);
    expect(Number(agg.delta)).toBeCloseTo(payload.aggregate.delta, 12);
    expect(await runsOf(experimentId)).toHaveLength(before); // an equal newest row is reused
  });

  it('400s a bad a or b and 404s an unknown experiment on all three endpoints', async () => {
    for (const path of ['export.json', 'export.csv', 'compare.csv']) {
      await get(`/experiments/NOPE/${path}`).expect(404);
    }
    await get('/experiments/%00/export.json').expect(404);
    await get(`/experiments/${experimentId}/export.json?a=${cfgA}&b=NOPE`).expect(400);
    await get(`/experiments/${experimentId}/compare.csv?a=${cfgA}&b=${cfgA}`).expect(400);
  });

  it('POST /trials/adhoc runs through the scheduler: a draft experiment with 1 pending trial, claimed by runNow, 1 attempt, then exportable', async () => {
    fake.reset();
    const original = scheduler.runNow.bind(scheduler);
    const seen: Array<{ experiment: string; trial: string; attempts: number }> = [];
    const spy = jest.spyOn(scheduler, 'runNow').mockImplementation(async (trialId: string) => {
      const t = await prisma.trial.findUniqueOrThrow({ where: { id: trialId }, include: { experiment: true, attempts: true } });
      seen.push({ experiment: t.experiment.status, trial: t.status, attempts: t.attempts.length });
      return original(trialId);
    });
    let res: request.Response;
    try {
      res = await http().post('/trials/adhoc').send({ config_id: cfgA, task_id: 'exe-01-ok' }).expect(201);
    } finally {
      spy.mockRestore();
    }

    expect(seen).toEqual([{ experiment: 'draft', trial: 'pending', attempts: 0 }]);
    expect(res.body.trial).toMatchObject({ status: 'done', passed: true, attempt_count: 1, trial_index: 0 });
    expect(fake.runs).toHaveLength(1);
    const exp = await prisma.experiment.findUniqueOrThrow({ where: { id: res.body.trial.experiment_id } });
    fx.track(exp.id);
    expect(exp).toMatchObject({ status: 'completed', nTrials: 1, phase: 'full' });
    expect(exp.startedAt).not.toBeNull();
    expect(exp.finishedAt).not.toBeNull();

    const csv = csvObjects((await get(`/experiments/${exp.id}/export.csv`).expect(200)).text);
    expect(csv).toHaveLength(1);
    expect(csv[0]).toMatchObject({ trial_id: res.body.trial.id, config_name: NASTY_NAME, status: 'done' });
    const json = (await get(`/experiments/${exp.id}/export.json`).expect(200)).body;
    expect(json.trials).toHaveLength(1);
    expect(json.comparison_runs).toEqual([]); // 1 config: nothing to compare
  });
});
