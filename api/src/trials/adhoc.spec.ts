import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { configBody, createTestApp, doneResult, FakeWorker } from '../test-support/app';
import { erroredResult } from './ingest';

describe('POST /trials/adhoc', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: FakeWorker;
  let http: ReturnType<typeof request>;
  let offId: string;
  let seededId: string;
  let n = 500;

  beforeAll(async () => {
    worker = new FakeWorker();
    ({ app, prisma } = await createTestApp(worker));
    http = request(app.getHttpServer());
    offId = (await http.post('/configs').send(configBody({}, { max_steps: 77 }))).body.id;
    seededId = (await http.post('/configs').send(configBody({ name: 'seeded' }, { max_steps: 77, memory: { mode: 'seeded', fixture: 'team-memory-v1' } }))).body.id;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    worker.runs = [];
    worker.run = (spec) => doneResult(spec);
  });

  const adhoc = (config_id: string, task_id = 'det-06-ini') => http.post('/trials/adhoc').send({ config_id, task_id });

  /** D-14 on a stored trial: passed is the AND of its grader rows. */
  async function expectD14(trialId: string) {
    const trial = await prisma.trial.findUniqueOrThrow({ where: { id: trialId } });
    const graders = await prisma.graderResult.findMany({ where: { trialId } });
    if (trial.status === 'done') expect(trial.passed).toBe(graders.every((g) => g.passed));
    else expect(trial.passed).toBeNull();
  }

  it('runs 1 trial, stores the trial, trace and grader results, and settles the experiment', async () => {
    const res = await adhoc(offId);
    expect(res.status).toBe(201);
    const { trial, trace, grader_results } = res.body;
    expect(trial).toMatchObject({ task_id: 'det-06-ini', status: 'done', passed: true, exit_reason: 'completed', steps: 2, input_tokens: 3000, output_tokens: 40, trial_index: 0, attempt_count: 1 });
    expect(trial.cost_usd).toBeCloseTo(0.0000576, 6);
    expect(trace.events.map((e: { kind: string }) => e.kind)).toEqual(['message', 'message', 'api_call', 'tool_call', 'tool_result', 'api_call', 'message']);
    expect(trace.final_response).toBe('FINAL: 8081');
    expect(trace.model_slug).toBe('openai/gpt-oss-20b');
    expect(grader_results[0]).toMatchObject({ grader_index: 0, grader_type: 'exact_match', passed: true });
    await expectD14(trial.id);

    const exp = await prisma.experiment.findUniqueOrThrow({ where: { id: trial.experiment_id }, include: { configs: true, tasks: true } });
    expect(exp).toMatchObject({ status: 'completed', nTrials: 1, phase: 'full' });
    expect(exp.name).toMatch(/^adhoc-[0-9A-Z]{26}$/);
    expect(exp.finishedAt).not.toBeNull();
    expect(exp.configs).toHaveLength(1);
    expect(exp.tasks[0].taskVersionHash).toMatch(/^[0-9a-f]{64}$/); // D-6: pinned by hash
    const attempts = await prisma.trialAttempt.findMany({ where: { trialId: trial.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attemptNo: 1, result: 'done' });
    expect(attempts[0].endedAt).not.toBeNull();
  });

  it('snapshots the model prices into the trial (D-7), so a later price change leaves history alone', async () => {
    const res = await adhoc(offId);
    expect(res.body.trial.price_snapshot).toEqual({ input_price_per_mtok: 0.018, output_price_per_mtok: 0.09 });
    await prisma.model.update({ where: { id: 'model-b' }, data: { inputPricePerMtok: 5 } });
    const again = await http.get(`/trials/${res.body.trial.id}`);
    expect(again.body.price_snapshot.input_price_per_mtok).toBe(0.018);
    expect(again.body.cost_usd).toBeCloseTo(0.0000576, 6);
    await prisma.model.update({ where: { id: 'model-b' }, data: { inputPricePerMtok: 0.018 } });
  });

  it('sends the worker the key NAME, never a key, and the task with its graders', async () => {
    await adhoc(offId);
    const spec = worker.runs[0];
    expect(spec.model.api_key_env).toBe('OPENROUTER_API_KEY');
    expect(JSON.stringify(spec)).not.toMatch(/sk-/);
    expect(spec).toMatchObject({ harness: 'hermes', attempt: 1, memory_seed: null });
    expect(spec.task).toMatchObject({ id: 'det-06-ini', fixture_dir: 'fixtures/det-06-ini' });
    expect(spec.task.graders).toEqual([{ type: 'exact_match', expected: '8081', expected_regex: null, normalize: ['trim'], extract: 'final_line' }]);
    expect(spec.settings.memory).toEqual({ mode: 'off', fixture: null, fixture_hash: null });
  });

  it('sends the stored fixture content as the memory seed for a seeded config', async () => {
    await adhoc(seededId, 'mem-01-staging-db');
    const spec = worker.runs[0];
    expect(Object.keys(spec.memory_seed!).sort()).toEqual(['MEMORY.md', 'USER.md']);
    expect(spec.memory_seed!['MEMORY.md']).toContain('pg-stage-07.internal');
    expect(spec.task.memory_fixture).toBe('team-memory-v1');
  });

  it('stores a timed-out trial as done and failed (R-2), with its pre-kill trace', async () => {
    worker.run = (spec) => doneResult(spec, {}, 'timeout');
    const res = await adhoc(offId);
    expect(res.body.trial).toMatchObject({ status: 'done', passed: false, exit_reason: 'timeout' });
    expect(res.body.trace.events.length).toBeGreaterThan(0);
    await expectD14(res.body.trial.id);
  });

  it('stores an errored trial with its class, keeps the partial events and marks the experiment partial (D-8)', async () => {
    worker.run = () => erroredResult('rate_limited', 'HTTP 429', [{ seq: 0, t_ms: 0, kind: 'api_call', http_status: 429 }]);
    const res = await adhoc(offId);
    expect(res.status).toBe(201);
    expect(res.body.trial).toMatchObject({ status: 'errored', passed: null, error_class: 'rate_limited', error_message: 'HTTP 429', rate_limit_events: 1, exit_reason: null });
    expect(res.body.trace).toMatchObject({ partial: true });
    expect(res.body.trace.events).toHaveLength(1);
    const exp = await prisma.experiment.findUniqueOrThrow({ where: { id: res.body.trial.experiment_id } });
    expect(exp.status).toBe('partial');
    const [attempt] = await prisma.trialAttempt.findMany({ where: { trialId: res.body.trial.id } });
    expect(attempt).toMatchObject({ result: 'errored', errorClass: 'rate_limited' });
    expect(attempt.partialTrace).toHaveLength(1);
    await expectD14(res.body.trial.id);
  });

  it('records worker_crash when the worker cannot be reached', async () => {
    worker.run = () => {
      throw new (class extends Error {})('connect ECONNREFUSED');
    };
    const res = await adhoc(offId);
    expect(res.body.trial).toMatchObject({ status: 'errored', error_class: 'worker_crash' });
    expect(res.body.trial.error_message).toContain('ECONNREFUSED');
  });

  it('records worker_crash, not a corrupt trial, when the worker result breaks D-14', async () => {
    worker.run = (spec) => {
      const r = doneResult(spec);
      r.passed = false; // graders say passed
      return r;
    };
    const res = await adhoc(offId);
    expect(res.body.trial).toMatchObject({ status: 'errored', error_class: 'worker_crash' });
    expect(res.body.trial.error_message).toContain('D-14');
    expect(res.body.trial.passed).toBeNull();
  });

  it('serves the trial and its trace by id, and the partial trace of an errored trial', async () => {
    const res = await adhoc(offId);
    const id = res.body.trial.id;
    const trial = await http.get(`/trials/${id}`);
    expect(trial.status).toBe(200);
    expect(trial.body.grader_results[0].passed).toBe(true);
    const trace = await http.get(`/trials/${id}/trace`);
    expect(trace.status).toBe(200);
    const kinds = new Set(trace.body.events.map((e: { kind: string }) => e.kind));
    expect(kinds).toEqual(new Set(['message', 'tool_call', 'tool_result', 'api_call']));
    expect(trace.body.final_response).toBe('FINAL: 8081');
    expect(trace.body.grader_results[0].passed).toBe(true);
    expect((await http.get('/trials/NOPE')).status).toBe(404);
    expect((await http.get('/trials/NOPE/trace')).status).toBe(404);
  });

  it('404s an unknown config or task, and 400s a bad body', async () => {
    expect((await adhoc('NOPE')).status).toBe(404);
    expect((await adhoc(offId, 'zzz-99-nope')).status).toBe(404);
    expect((await http.post('/trials/adhoc').send({ config_id: offId })).status).toBe(400);
    expect((await http.post('/trials/adhoc').send({ config_id: offId, task_id: 'det-06-ini', extra: 1 })).status).toBe(400);
  });

  it('gives each ad hoc run its own experiment and the same seed for the same (config, task)', async () => {
    const a = await adhoc(offId);
    const b = await adhoc(offId);
    expect(a.body.trial.experiment_id).not.toBe(b.body.trial.experiment_id);
    expect(a.body.trial.seed).toBe(b.body.trial.seed);
    n += 1;
  });
});
