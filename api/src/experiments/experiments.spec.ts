import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { createExperimentsApp, FakeScheduler } from '../../test/experiments-app';
import { PrismaService } from '../prisma/prisma.service';
import { configBody, FakeWorker, HERMES_VERSION, MANIFEST } from '../test-support/app';
import { sqlState } from '../test-support/db';
import { trialSeed } from '../trials/seed';

const TASKS = ['det-01-csv-count', 'det-02-hello', 'det-03-slugify', 'det-04-median'];

describe('experiments (S1): CRUD, trial generation, transitions', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: FakeWorker;
  let scheduler: FakeScheduler;
  let http: ReturnType<typeof request>;
  let cfgA: string;
  let cfgB: string;
  let cfgC: string;
  let counter = 0;

  beforeAll(async () => {
    ({ app, prisma, worker, scheduler } = await createExperimentsApp());
    http = request(app.getHttpServer());
    // Distinct max_steps keep these configs out of any other spec's way: configs are content-addressed (D-3).
    cfgA = (await http.post('/configs').send(configBody({ name: 'exp A' }, { max_steps: 9101 }))).body.id;
    cfgB = (await http.post('/configs').send(configBody({ name: 'exp B' }, { max_steps: 9102 }))).body.id;
    cfgC = (await http.post('/configs').send(configBody({ name: 'exp C' }, { max_steps: 9103 }))).body.id;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    worker.manifest = MANIFEST;
  });

  const name = (what: string) => `${what} #${++counter} ${Date.now()}`;

  const create = (over: Record<string, unknown> = {}) =>
    http.post('/experiments').send({ name: name('exp'), config_ids: [cfgA, cfgB], task_ids: TASKS, n_trials: 2, ...over });

  async function draft(over: Record<string, unknown> = {}): Promise<string> {
    const res = await create(over);
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function started(over: Record<string, unknown> = {}): Promise<string> {
    const id = await draft(over);
    const res = await http.post(`/experiments/${id}/start`);
    expect(res.status).toBe(200);
    return id;
  }

  const trialCount = (experimentId: string, where: Record<string, unknown> = {}) => prisma.trial.count({ where: { experimentId, ...where } });

  /** A task row that is not one of the 22, with its own id so tests cannot interfere. */
  async function insertTask(isCurrent = true, versionHash?: string, id?: string): Promise<{ id: string; hash: string }> {
    const taskId = id ?? `tst-${String(10 + (++counter % 90))}-x${Date.now().toString(36)}${counter}`;
    const hash = versionHash ?? `hash-${taskId}`;
    await prisma.task.create({
      data: {
        id: taskId,
        versionHash: hash,
        category: 'neutral_deterministic',
        prompt: 'p',
        graders: [{ type: 'exact_match' }],
        discriminates: ['model'],
        tags: [],
        isCurrent,
      },
    });
    return { id: taskId, hash };
  }

  /** Marks every trial of an experiment as done, so a derived status can be forced in the DB without an errored trial (D-8). */
  async function finishAll(experimentId: string, status: 'completed' | 'partial') {
    await prisma.trial.updateMany({ where: { experimentId }, data: { status: 'done', passed: true, exitReason: 'completed' } });
    await prisma.experiment.update({ where: { id: experimentId }, data: { status, finishedAt: new Date() } });
  }

  describe('POST /experiments', () => {
    it('creates a draft with ordered configs, pinned task hashes, the worker manifest, hypothesis and axis', async () => {
      const res = await create({ config_ids: [cfgB, cfgA], hypothesis: 'memory helps', axis: 'memory', n_trials: 3, seed: 42 });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'draft',
        n_trials: 3,
        seed: 42,
        phase: 'full',
        axis: 'memory',
        hypothesis: 'memory helps',
        paused: false,
        pause_reason: null,
        progress: { pending: 0, running: 0, done: 0, errored: 0, cancelled: 0, total: 0 },
      });
      expect(res.body.worker_manifest).toEqual(MANIFEST);
      expect(res.body.configs).toEqual([
        { id: cfgB, name: 'exp B', position: 0, harness_id: 'hermes', model_slug: expect.any(String) },
        { id: cfgA, name: 'exp A', position: 1, harness_id: 'hermes', model_slug: expect.any(String) },
      ]);
      expect(res.body.tasks.map((t: { task_id: string }) => t.task_id).sort()).toEqual([...TASKS].sort());
      for (const t of res.body.tasks) {
        const current = await prisma.task.findFirstOrThrow({ where: { id: t.task_id, isCurrent: true } });
        expect(t).toEqual({ task_id: t.task_id, task_version_hash: current.versionHash, category: current.category }); // D-6
      }
      expect(await trialCount(res.body.id)).toBe(0);
    });

    it('stores phase pilot and defaults the seed to an int31', async () => {
      const res = await create({ phase: 'pilot' });
      expect(res.body.phase).toBe('pilot');
      expect(Number.isInteger(res.body.seed)).toBe(true);
      expect(res.body.seed).toBeGreaterThanOrEqual(0);
      expect(res.body.seed).toBeLessThanOrEqual(2 ** 31 - 1);
    });

    it('defaults the task set to every current task, each pinned to its current hash', async () => {
      const res = await http.post('/experiments').send({ name: name('all tasks'), config_ids: [cfgA, cfgB], n_trials: 1 });
      expect(res.status).toBe(201);
      const current = await prisma.task.findMany({ where: { isCurrent: true } });
      expect(current.length).toBeGreaterThanOrEqual(22);
      expect(res.body.tasks).toHaveLength(current.length);
      const byId = new Map(current.map((t) => [t.id, t.versionHash]));
      for (const t of res.body.tasks) expect(byId.get(t.task_id)).toBe(t.task_version_hash);
    });

    it('pins the CURRENT version hash when a task has an older version (D-6)', async () => {
      const id = `tst-77-v${Date.now().toString(36)}${++counter}`;
      await insertTask(false, 'old-hash', id);
      await insertTask(true, 'new-hash', id);
      const res = await create({ task_ids: [id] });
      expect(res.status).toBe(201);
      expect(res.body.tasks).toEqual([{ task_id: id, task_version_hash: 'new-hash', category: 'neutral_deterministic' }]);
    });

    it.each([
      ['a missing name', { name: undefined }],
      ['a blank name', { name: '   ' }],
      ['fewer than 2 configs', { config_ids: [cfgA] }],
      ['no configs', { config_ids: [] }],
      ['n_trials 0', { n_trials: 0 }],
      ['a fractional n_trials', { n_trials: 1.5 }],
      ['a missing n_trials', { n_trials: undefined }],
      ['an empty task_ids', { task_ids: [] }],
      ['a non-integer seed', { seed: 1.5 }],
      ['a seed beyond int31', { seed: 2 ** 31 }],
      ['an unknown phase', { phase: 'huge' }],
      ['an unknown key', { status: 'running' }],
    ])('400 for %s', async (_what, over) => {
      const res = await create(over);
      expect(res.status).toBe(400);
    });

    it('400 for duplicate configs and duplicate tasks', async () => {
      expect((await create({ config_ids: [cfgA, cfgA] })).status).toBe(400);
      expect((await create({ task_ids: [TASKS[0], TASKS[0]] })).status).toBe(400);
    });

    it('404 for an unknown config, an unknown task and a task with no current version', async () => {
      expect((await create({ config_ids: [cfgA, 'no-such-config'] })).status).toBe(404);
      expect((await create({ task_ids: [TASKS[0], 'zzz-99-nope'] })).status).toBe(404);
      const retired = await insertTask(false);
      expect((await create({ task_ids: [retired.id] })).status).toBe(404);
    });

    it('stores {} when the worker is unreachable, and start takes the snapshot again', async () => {
      worker.manifest = new Error('connection refused');
      const id = await draft();
      expect((await prisma.experiment.findUniqueOrThrow({ where: { id } })).workerManifest).toEqual({});
      worker.manifest = MANIFEST;
      await http.post(`/experiments/${id}/start`).expect(200);
      expect((await prisma.experiment.findUniqueOrThrow({ where: { id } })).workerManifest).toEqual(MANIFEST);
    });
  });

  describe('POST /experiments/:id/start', () => {
    it('creates exactly configs x tasks x n trials with the DATA_MODEL seeds, price snapshot and pending status', async () => {
      const id = await draft({ config_ids: [cfgA, cfgB, cfgC], n_trials: 3, seed: 7 });
      const res = await http.post(`/experiments/${id}/start`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('queued');
      expect(res.body.progress).toEqual({ pending: 36, running: 0, done: 0, errored: 0, cancelled: 0, total: 36 });

      const trials = await prisma.trial.findMany({ where: { experimentId: id }, include: { config: { include: { model: true } } } });
      expect(trials).toHaveLength(3 * TASKS.length * 3);
      const keys = new Set(trials.map((t) => `${t.configId}|${t.taskId}|${t.trialIndex}`));
      expect(keys.size).toBe(trials.length);
      for (const c of [cfgA, cfgB, cfgC]) for (const t of TASKS) for (let i = 0; i < 3; i++) expect(keys.has(`${c}|${t}|${i}`)).toBe(true);

      const exp = await prisma.experiment.findUniqueOrThrow({ where: { id }, include: { tasks: true } });
      const hashOf = new Map(exp.tasks.map((t) => [t.taskId, t.taskVersionHash]));
      for (const t of trials) {
        expect(t.seed).toBe(trialSeed(7, t.configId, t.taskId, t.trialIndex));
        expect(t.status).toBe('pending');
        expect(t.attemptCount).toBe(0);
        expect(t.taskVersionHash).toBe(hashOf.get(t.taskId));
        expect(t.priceSnapshot).toEqual({
          input_price_per_mtok: t.config.model.inputPricePerMtok.toNumber(),
          output_price_per_mtok: t.config.model.outputPricePerMtok.toNumber(),
        });
      }
      expect(new Set(trials.map((t) => t.seed)).size).toBe(trials.length); // distinct seeds
      expect(scheduler.kick).toHaveBeenCalledTimes(1);
    });

    it('409 on a second start, creating nothing more', async () => {
      const id = await started();
      const before = await trialCount(id);
      expect((await http.post(`/experiments/${id}/start`)).status).toBe(409);
      expect(await trialCount(id)).toBe(before);
    });

    it('2 concurrent starts create the trials once', async () => {
      const id = await draft();
      const results = await Promise.all([http.post(`/experiments/${id}/start`), http.post(`/experiments/${id}/start`)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await trialCount(id)).toBe(2 * TASKS.length * 2);
    });

    it('404 for an unknown experiment', async () => {
      expect((await http.post('/experiments/nope/start')).status).toBe(404);
    });
  });

  describe('POST /experiments/:id/extend', () => {
    it('adds exactly the missing indices: 2 configs x 4 tasks, N 2 to 3 adds 8 trials with trial_index 2', async () => {
      const id = await started({ seed: 11 });
      const old = await prisma.trial.findMany({ where: { experimentId: id }, select: { id: true } });
      expect(old).toHaveLength(16);
      const res = await http.post(`/experiments/${id}/extend`).send({ n_trials: 3 });
      expect(res.status).toBe(200);
      expect(res.body.n_trials).toBe(3);
      expect(await trialCount(id)).toBe(24);
      const added = await prisma.trial.findMany({ where: { experimentId: id, trialIndex: 2 } });
      expect(added).toHaveLength(8);
      for (const t of added) {
        expect(t.status).toBe('pending');
        expect(t.seed).toBe(trialSeed(11, t.configId, t.taskId, 2));
      }
      const survivors = await prisma.trial.count({ where: { id: { in: old.map((o) => o.id) } } });
      expect(survivors).toBe(16); // existing trials are untouched
      expect(scheduler.kick).toHaveBeenCalled();
    });

    it('adds every index in [old, new) when N rises by more than 1', async () => {
      const id = await started({ n_trials: 1 });
      await http.post(`/experiments/${id}/extend`).send({ n_trials: 4 }).expect(200);
      expect(await trialCount(id)).toBe(4 * 8);
      const indices = await prisma.trial.findMany({ where: { experimentId: id }, distinct: ['trialIndex'], select: { trialIndex: true } });
      expect(indices.map((t) => t.trialIndex).sort()).toEqual([0, 1, 2, 3]);
    });

    it('refuses an equal or smaller n_trials with 409, and the database trigger agrees (D-9)', async () => {
      const id = await started({ n_trials: 3 });
      expect((await http.post(`/experiments/${id}/extend`).send({ n_trials: 3 })).status).toBe(409);
      expect((await http.post(`/experiments/${id}/extend`).send({ n_trials: 2 })).status).toBe(409);
      expect(await trialCount(id)).toBe(24);
      const err = await sqlState(prisma.$executeRaw`UPDATE experiment SET n_trials = 2 WHERE id = ${id}`);
      expect(err?.message).toMatch(/D-9/);
      expect((await prisma.experiment.findUniqueOrThrow({ where: { id } })).nTrials).toBe(3);
    });

    it('reopens completed to running and flips a pilot to full', async () => {
      const id = await started({ phase: 'pilot' });
      await finishAll(id, 'completed');
      const res = await http.post(`/experiments/${id}/extend`).send({ n_trials: 3 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'running', phase: 'full', finished_at: null });
      expect(res.body.progress).toMatchObject({ pending: 8, done: 16, total: 24 });
    });

    it('reopens partial to running', async () => {
      const id = await started();
      await finishAll(id, 'partial');
      const res = await http.post(`/experiments/${id}/extend`).send({ n_trials: 3 });
      expect(res.body).toMatchObject({ status: 'running', finished_at: null, phase: 'full' });
    });

    it('keeps a given phase, and leaves a running or queued experiment in its status', async () => {
      const q = await started({ phase: 'pilot' });
      const res = await http.post(`/experiments/${q}/extend`).send({ n_trials: 3, phase: 'pilot' });
      expect(res.body).toMatchObject({ status: 'queued', phase: 'pilot' });
      await prisma.experiment.update({ where: { id: q }, data: { status: 'running', startedAt: new Date() } });
      expect((await http.post(`/experiments/${q}/extend`).send({ n_trials: 4 })).body.status).toBe('running');
    });

    it('refuses a cancelled experiment', async () => {
      const id = await started();
      await http.post(`/experiments/${id}/cancel`).expect(200);
      expect((await http.post(`/experiments/${id}/extend`).send({ n_trials: 5 })).status).toBe(409);
    });

    it('on a draft only raises n_trials and creates no trial', async () => {
      const id = await draft({ n_trials: 2 });
      const res = await http.post(`/experiments/${id}/extend`).send({ n_trials: 5 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'draft', n_trials: 5 });
      expect(await trialCount(id)).toBe(0);
      await http.post(`/experiments/${id}/start`).expect(200);
      expect(await trialCount(id)).toBe(5 * 8);
    });

    it('2 concurrent extends to the same N create the indices once (row lock, D-12)', async () => {
      const id = await started();
      const results = await Promise.all([
        http.post(`/experiments/${id}/extend`).send({ n_trials: 3 }),
        http.post(`/experiments/${id}/extend`).send({ n_trials: 3 }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await trialCount(id)).toBe(24);
    });

    it('400 for a bad body, 404 for an unknown experiment', async () => {
      const id = await started();
      expect((await http.post(`/experiments/${id}/extend`).send({})).status).toBe(400);
      expect((await http.post(`/experiments/${id}/extend`).send({ n_trials: 0 })).status).toBe(400);
      expect((await http.post(`/experiments/${id}/extend`).send({ n_trials: 3, seed: 1 })).status).toBe(400);
      expect((await http.post('/experiments/nope/extend').send({ n_trials: 3 })).status).toBe(404);
    });
  });

  describe('POST /experiments/:id/cancel', () => {
    it('cancels pending and running trials, closes the open attempts, and tells the worker about the running ones only', async () => {
      const id = await started({ n_trials: 1 });
      const trials = await prisma.trial.findMany({ where: { experimentId: id }, orderBy: { id: 'asc' } });
      const [run1, run2, doneT] = trials;
      const now = new Date();
      await prisma.trial.updateMany({
        where: { id: { in: [run1.id, run2.id] } },
        data: { status: 'running', attemptCount: 1, startedAt: now, heartbeatAt: now },
      });
      await prisma.trialAttempt.createMany({
        data: [run1, run2].map((t, i) => ({ id: `att-${t.id}-${i}`, trialId: t.id, attemptNo: 1, startedAt: now })),
      });
      await prisma.trial.update({ where: { id: doneT.id }, data: { status: 'done', passed: true, exitReason: 'completed', attemptCount: 1 } });
      await prisma.experiment.update({ where: { id }, data: { status: 'running', startedAt: now, pauseReason: 'circuit breaker: test' } });

      const res = await http.post(`/experiments/${id}/cancel`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'cancelled', paused: false, pause_reason: null });
      expect(res.body.finished_at).not.toBeNull();
      expect(res.body.progress).toMatchObject({ pending: 0, running: 0, done: 1, cancelled: trials.length - 1 });

      for (const t of await prisma.trial.findMany({ where: { experimentId: id, status: 'cancelled' } })) {
        expect(t).toMatchObject({ errorClass: 'cancelled', errorMessage: 'cancelled with the experiment', passed: null });
        expect(t.endedAt).not.toBeNull();
      }
      expect((await prisma.trial.findUniqueOrThrow({ where: { id: doneT.id } })).status).toBe('done');
      for (const a of await prisma.trialAttempt.findMany({ where: { trialId: { in: [run1.id, run2.id] } } })) {
        expect(a.result).toBe('cancelled');
        expect(a.endedAt).not.toBeNull();
      }
      expect(scheduler.cancelOnWorker).toHaveBeenCalledTimes(1);
      expect([...scheduler.cancelOnWorker.mock.calls[0][0]].sort()).toEqual([run1.id, run2.id].sort());
    });

    it('409 on a second cancel and on a finished experiment', async () => {
      const id = await started();
      await http.post(`/experiments/${id}/cancel`).expect(200);
      expect((await http.post(`/experiments/${id}/cancel`)).status).toBe(409);
      const done = await started();
      await finishAll(done, 'completed');
      expect((await http.post(`/experiments/${done}/cancel`)).status).toBe(409);
    });

    it('cancels a draft, which has no trials', async () => {
      const id = await draft();
      const res = await http.post(`/experiments/${id}/cancel`);
      expect(res.body.status).toBe('cancelled');
      expect(scheduler.cancelOnWorker).toHaveBeenCalledWith([]);
    });

    it('404 for an unknown experiment', async () => {
      expect((await http.post('/experiments/nope/cancel')).status).toBe(404);
    });
  });

  describe('POST /experiments/:id/resume', () => {
    it('clears pause_reason, resets the breaker and kicks the scheduler', async () => {
      const id = await started();
      await prisma.experiment.update({
        where: { id },
        data: { status: 'running', startedAt: new Date(), pauseReason: 'circuit breaker: 5 consecutive terminal errors' },
      });
      const paused = await http.get(`/experiments/${id}`);
      expect(paused.body).toMatchObject({ paused: true, pause_reason: 'circuit breaker: 5 consecutive terminal errors' });
      jest.clearAllMocks();

      const res = await http.post(`/experiments/${id}/resume`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ paused: false, pause_reason: null, status: 'running' });
      expect(scheduler.resetBreaker).toHaveBeenCalledWith(id);
      expect(scheduler.kick).toHaveBeenCalledTimes(1);
    });

    it('409 when the experiment is not paused, and nothing is reset', async () => {
      const id = await started();
      expect((await http.post(`/experiments/${id}/resume`)).status).toBe(409);
      expect((await http.post(`/experiments/${await draft()}/resume`)).status).toBe(409);
      expect(scheduler.resetBreaker).not.toHaveBeenCalled();
    });

    it('404 for an unknown experiment', async () => {
      expect((await http.post('/experiments/nope/resume')).status).toBe(404);
    });
  });

  describe('GET', () => {
    it('GET /experiments/:id reports progress counts by trial status', async () => {
      const id = await started({ n_trials: 1 });
      const trials = await prisma.trial.findMany({ where: { experimentId: id }, orderBy: { id: 'asc' } });
      await prisma.trial.update({ where: { id: trials[0].id }, data: { status: 'running', attemptCount: 1 } });
      await prisma.trial.update({ where: { id: trials[1].id }, data: { status: 'done', passed: false, exitReason: 'completed', failureCategory: 'wrong_answer', failureEvidence: { rule: 10, category: 'wrong_answer', detail: 'fixture' } } });
      await prisma.trial.update({ where: { id: trials[2].id }, data: { status: 'errored', errorClass: 'config_invalid' } });
      await prisma.trial.update({ where: { id: trials[3].id }, data: { status: 'cancelled' } });
      const res = await http.get(`/experiments/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.progress).toEqual({ pending: 4, running: 1, done: 1, errored: 1, cancelled: 1, total: 8 });
      expect(res.body.configs).toHaveLength(2);
      expect(res.body.tasks).toHaveLength(4);
    });

    it('GET /experiments lists newest first with progress and without the config and task lists', async () => {
      const first = await started({ n_trials: 1 });
      const second = await draft();
      const res = await http.get('/experiments');
      expect(res.status).toBe(200);
      const ids = res.body.map((e: { id: string }) => e.id);
      expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
      const row = res.body.find((e: { id: string }) => e.id === first);
      expect(row.progress).toMatchObject({ pending: 8, total: 8 });
      expect(row.configs).toBeUndefined();
      expect(row.tasks).toBeUndefined();
      expect(row).toMatchObject({ status: 'queued', paused: false });
    });

    it('GET /experiments/:id/trials filters by status, config_id and task_id', async () => {
      const id = await started({ n_trials: 2 });
      const all = await http.get(`/experiments/${id}/trials`);
      expect(all.status).toBe(200);
      expect(all.body).toHaveLength(16);
      expect(all.body[0]).toEqual(
        expect.objectContaining({ experiment_id: id, status: 'pending', attempt_count: 0, price_snapshot: expect.any(Object), cost_usd: null, passed: null }),
      );
      expect(all.body[0].grader_results).toBeUndefined();

      const one = (await prisma.trial.findFirstOrThrow({ where: { experimentId: id } })).id;
      await prisma.trial.update({ where: { id: one }, data: { status: 'running', attemptCount: 1 } });
      expect((await http.get(`/experiments/${id}/trials?status=running`)).body.map((t: { id: string }) => t.id)).toEqual([one]);
      expect((await http.get(`/experiments/${id}/trials?config_id=${cfgA}`)).body).toHaveLength(8);
      expect((await http.get(`/experiments/${id}/trials?task_id=${TASKS[1]}`)).body).toHaveLength(4);
      const combined = await http.get(`/experiments/${id}/trials?config_id=${cfgB}&task_id=${TASKS[1]}&status=pending`);
      expect(combined.body).toHaveLength(2);
      expect((await http.get(`/experiments/${id}/trials?status=bogus`)).status).toBe(400);
    });

    it('404 for an unknown experiment on every read', async () => {
      expect((await http.get('/experiments/nope')).status).toBe(404);
      expect((await http.get('/experiments/nope/trials')).status).toBe(404);
    });
  });

  describe('route id guard', () => {
    it('an id with a NUL byte is a 404 on a read and on a write, not a 500', async () => {
      expect((await http.get('/experiments/%00')).status).toBe(404);
      expect((await http.post('/experiments/%00/start')).status).toBe(404);
      expect((await http.get('/experiments/%00/trials')).status).toBe(404);
      expect((await http.post('/experiments/a%00b/cancel')).status).toBe(404);
    });
  });

  describe('D-10 pre-registration', () => {
    it('the database rejects editing hypothesis or axis after start, and allows it on a draft', async () => {
      const id = await draft({ hypothesis: 'h0', axis: 'memory' });
      await prisma.experiment.update({ where: { id }, data: { hypothesis: 'h1' } }); // a draft may still be edited
      await http.post(`/experiments/${id}/start`).expect(200);
      const h = await sqlState(prisma.$executeRaw`UPDATE experiment SET hypothesis = 'changed' WHERE id = ${id}`);
      expect(h?.message).toMatch(/D-10/);
      const a = await sqlState(prisma.$executeRaw`UPDATE experiment SET axis = 'skills' WHERE id = ${id}`);
      expect(a?.message).toMatch(/D-10/);
      expect(await prisma.experiment.findUniqueOrThrow({ where: { id } })).toMatchObject({ hypothesis: 'h1', axis: 'memory' });
    });

    it('exposes no edit endpoint', async () => {
      const id = await draft({ hypothesis: 'h' });
      expect((await http.patch(`/experiments/${id}`).send({ hypothesis: 'x' })).status).toBe(404);
      expect((await http.put(`/experiments/${id}`).send({ hypothesis: 'x' })).status).toBe(404);
    });
  });

  describe('POST /experiments/:id/reproduce', () => {
    it('creates a draft with the same configs, positions, task hashes, plan and a new seed', async () => {
      const old = await create({ config_ids: [cfgB, cfgA], hypothesis: 'h', axis: 'memory', n_trials: 3, phase: 'pilot', seed: 5 });
      await http.post(`/experiments/${old.body.id}/start`).expect(200);
      const res = await http.post(`/experiments/${old.body.id}/reproduce`).send({});
      expect(res.status).toBe(201);
      expect(res.body.id).not.toBe(old.body.id);
      expect(res.body).toMatchObject({
        status: 'draft',
        name: `${old.body.name} (reproduction)`,
        n_trials: 3,
        phase: 'pilot',
        axis: 'memory',
        hypothesis: 'h',
        progress: { total: 0 },
      });
      expect(res.body.seed).not.toBe(5);
      expect(res.body.configs.map((c: { id: string; position: number }) => [c.id, c.position])).toEqual([[cfgB, 0], [cfgA, 1]]);
      expect(res.body.tasks).toEqual(old.body.tasks);
      expect(await trialCount(res.body.id)).toBe(0);
    });

    it('accepts a seed, and an empty body', async () => {
      const id = await draft();
      expect((await http.post(`/experiments/${id}/reproduce`).send({ seed: 99 })).body.seed).toBe(99);
      expect((await http.post(`/experiments/${id}/reproduce`)).status).toBe(201);
      expect((await http.post(`/experiments/${id}/reproduce`).send({ seed: 'x' })).status).toBe(400);
    });

    it('refuses a pin that is no longer the current version: the worker would run another version than the one pinned', async () => {
      const id = `tst-78-r${Date.now().toString(36)}${++counter}`;
      await insertTask(true, 'hash-1', id);
      const old = await draft({ task_ids: [id, TASKS[0]] });
      await prisma.task.update({ where: { id_versionHash: { id, versionHash: 'hash-1' } }, data: { isCurrent: false } });
      await insertTask(true, 'hash-2', id);
      const res = await http.post(`/experiments/${old}/reproduce`).send({});
      expect(res.status).toBe(409);
      expect(res.body.problems).toEqual([`task ${id} is pinned at hash-1 but the current version is hash-2; re-create the experiment`]);
      expect(await prisma.experiment.count({ where: { name: { endsWith: '(reproduction)' }, tasks: { some: { taskId: id } } } })).toBe(0);
    });

    it('refuses with the list of problems when a pinned task hash is missing', async () => {
      const t = await insertTask();
      const old = await draft({ task_ids: [t.id, TASKS[0]] });
      // The FK would stop a plain DELETE; replica mode skips it, which is how the row could be lost by hand.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.$executeRaw`DELETE FROM task WHERE id = ${t.id} AND version_hash = ${t.hash}`;
      });
      try {
        const res = await http.post(`/experiments/${old}/reproduce`).send({});
        expect(res.status).toBe(409);
        expect(res.body.problems).toEqual([`task ${t.id}@${t.hash} is no longer stored`]);
        expect(res.body.message).toMatch(/cannot be reproduced/);
      } finally {
        await prisma.task.create({
          data: {
            id: t.id,
            versionHash: t.hash,
            category: 'neutral_deterministic',
            prompt: 'p',
            graders: [{ type: 'exact_match' }],
            discriminates: ['model'],
            tags: [],
            isCurrent: true,
          },
        });
      }
    });

    it('refuses when a memory fixture a config pins is no longer stored', async () => {
      const cfg = await prisma.config.create({
        data: {
          id: `cfg-${Date.now().toString(36)}${++counter}`,
          name: 'gone fixture',
          harnessId: 'hermes',
          harnessVersion: HERMES_VERSION,
          modelId: 'model-b',
          modelSlug: (await prisma.model.findUniqueOrThrow({ where: { id: 'model-b' } })).slug,
          settings: { ...configBody().settings, memory: { mode: 'seeded', fixture: 'vanished', fixture_hash: 'deadbeef' } },
          configHash: `hash-${Date.now()}-${counter}`,
        },
      });
      const old = await draft({ config_ids: [cfgA, cfg.id] });
      const res = await http.post(`/experiments/${old}/reproduce`).send({});
      expect(res.status).toBe(409);
      expect(res.body.problems).toEqual([`memory fixture vanished@deadbeef of config ${cfg.id} is no longer stored (D-5)`]);
    });

    it('refuses when the worker version drifted since the original ran', async () => {
      const old = await draft();
      worker.manifest = { ...MANIFEST, adapters: MANIFEST.adapters.map((a) => ({ ...a, version: 'ffffffffff' })) };
      const res = await http.post(`/experiments/${old}/reproduce`).send({});
      expect(res.status).toBe(409);
      expect(res.body.problems).toEqual([`harness hermes version changed on the worker: ${HERMES_VERSION} -> ffffffffff`]);
      worker.manifest = { ...MANIFEST, adapters: [] };
      expect((await http.post(`/experiments/${old}/reproduce`).send({})).body.problems).toEqual(['harness hermes is no longer registered on the worker']);
    });

    it('refuses when the worker is unreachable, and when the original recorded no manifest', async () => {
      const old = await draft();
      worker.manifest = new Error('connection refused');
      const res = await http.post(`/experiments/${old}/reproduce`).send({});
      expect(res.status).toBe(409);
      expect(res.body.problems).toHaveLength(1);
      expect(res.body.problems[0]).toMatch(/worker cannot be reached.*connection refused/);

      const blank = await draft(); // created while the worker answered ...
      await prisma.experiment.update({ where: { id: blank }, data: { workerManifest: {} } }); // ... then forced to {}
      worker.manifest = MANIFEST;
      const res2 = await http.post(`/experiments/${blank}/reproduce`).send({});
      expect(res2.status).toBe(409);
      expect(res2.body.problems).toEqual(['the original experiment recorded no worker manifest, so its harness versions cannot be compared']);
    });

    it('collects every problem in 1 refusal', async () => {
      worker.manifest = new Error('down');
      const old = await draft();
      const res = await http.post(`/experiments/${old}/reproduce`).send({});
      expect(res.status).toBe(409);
      worker.manifest = MANIFEST;
      expect(res.body.problems).toHaveLength(2); // unreachable now, and nothing recorded at creation
    });

    it('404 for an unknown experiment', async () => {
      expect((await http.post('/experiments/nope/reproduce').send({})).status).toBe(404);
    });

    it('succeeds for a config that seeds memory from a fixture that is still stored', async () => {
      const fixture = { name: `fx-keep-${Date.now().toString(36)}${++counter}`, hash: 'cafebabe' };
      await prisma.memoryFixture.create({ data: { ...fixture, files: { 'MEMORY.md': '# memory', 'USER.md': '# user' } } });
      try {
        const cfg = await prisma.config.create({
          data: {
            id: `cfg-${Date.now().toString(36)}${++counter}`,
            name: 'seeded and present',
            harnessId: 'hermes',
            harnessVersion: HERMES_VERSION,
            modelId: 'model-b',
            modelSlug: (await prisma.model.findUniqueOrThrow({ where: { id: 'model-b' } })).slug,
            settings: { ...configBody().settings, memory: { mode: 'seeded', fixture: fixture.name, fixture_hash: fixture.hash } },
            configHash: `hash-${Date.now()}-${counter}`,
          },
        });
        const old = await draft({ config_ids: [cfgA, cfg.id], n_trials: 2, hypothesis: 'seeded memory helps', axis: 'memory' });
        const res = await http.post(`/experiments/${old}/reproduce`).send({});
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ status: 'draft', n_trials: 2, hypothesis: 'seeded memory helps', axis: 'memory' });
        expect(res.body.configs.map((c: { id: string }) => c.id)).toEqual([cfgA, cfg.id]);
        expect(res.body.worker_manifest).toEqual(MANIFEST);
        // and it refuses the moment the fixture is gone
        await prisma.memoryFixture.deleteMany({ where: fixture });
        const gone = await http.post(`/experiments/${old}/reproduce`).send({});
        expect(gone.status).toBe(409);
        expect(gone.body.problems).toEqual([`memory fixture ${fixture.name}@${fixture.hash} of config ${cfg.id} is no longer stored (D-5)`]);
      } finally {
        await prisma.memoryFixture.deleteMany({ where: fixture });
      }
    });
  });

  describe('review fixes: limits, phase, query validation, pause state, lock-order contract', () => {
    it('400 for an n_trials above 1000 on create and on extend, and for a plan beyond 20000 trial rows', async () => {
      expect((await create({ n_trials: 1001 })).status).toBe(400);
      expect((await create({ n_trials: 2 ** 31 })).status).toBe(400); // used to be an int4 overflow, a 500
      const id = await started({ n_trials: 1 });
      expect((await http.post(`/experiments/${id}/extend`).send({ n_trials: 1001 })).status).toBe(400);
      expect((await http.post(`/experiments/${id}/extend`).send({ n_trials: 2000000000 })).status).toBe(400);
      // all current tasks (22 or more) x 2 configs x 1000 is far beyond 20000
      const big = await http.post('/experiments').send({ name: name('big'), config_ids: [cfgA, cfgB], n_trials: 1000 });
      expect(big.status).toBe(400);
      expect(big.body.message).toMatch(/at most 20000/);
      // the largest n_trials still works: 2 configs x 1 task x 1000 = 2000 rows, written in 2 chunks
      const wide = await draft({ task_ids: [TASKS[0]], n_trials: 1000 });
      await http.post(`/experiments/${wide}/start`).expect(200);
      expect(await trialCount(wide)).toBe(2000);
    });

    it('refuses an extend whose new rows exceed 20000, on a draft and on a started experiment, creating nothing', async () => {
      const tasks = (await prisma.task.findMany({ where: { isCurrent: true }, orderBy: { id: 'asc' }, take: 22 })).map((t) => t.id);
      expect(tasks).toHaveLength(22);
      const id = await draft({ task_ids: tasks, n_trials: 1 }); // 44 rows at N=1
      expect((await http.post(`/experiments/${id}/extend`).send({ n_trials: 500 })).status).toBe(400); // 22000 on start
      expect((await prisma.experiment.findUniqueOrThrow({ where: { id } })).nTrials).toBe(1);
      await http.post(`/experiments/${id}/start`).expect(200);
      const before = await trialCount(id);
      expect((await http.post(`/experiments/${id}/extend`).send({ n_trials: 500 })).status).toBe(400); // 499 x 44 = 21956 new rows
      expect(await trialCount(id)).toBe(before);
      expect((await http.post(`/experiments/${id}/extend`).send({ n_trials: 50 })).status).toBe(200); // 49 x 44 = 2156
      expect(await trialCount(id)).toBe(44 * 50);
    });

    it('caps the resulting plan, not only the new rows: 2 x 20 x 400 started, extend to 800 is refused (32000 in all)', async () => {
      const tasks = (await prisma.task.findMany({ where: { isCurrent: true }, orderBy: { id: 'asc' }, take: 20 })).map((t) => t.id);
      expect(tasks).toHaveLength(20);
      const id = await started({ task_ids: tasks, n_trials: 400 }); // 16000 rows
      try {
        expect(await trialCount(id)).toBe(16000);
        const res = await http.post(`/experiments/${id}/extend`).send({ n_trials: 800 }); // 16000 new rows: under the per-request cap
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/32000 trial rows; at most 20000 in all/);
        expect(await trialCount(id)).toBe(16000);
        expect((await prisma.experiment.findUniqueOrThrow({ where: { id } })).nTrials).toBe(400);
        expect((await http.post(`/experiments/${id}/extend`).send({ n_trials: 500 })).status).toBe(200); // 20000 in all is allowed
        expect(await trialCount(id)).toBe(20000);
      } finally {
        await prisma.trial.deleteMany({ where: { experimentId: id } });
        await prisma.experimentTask.deleteMany({ where: { experimentId: id } });
        await prisma.experimentConfig.deleteMany({ where: { experimentId: id } });
        await prisma.experiment.delete({ where: { id } });
      }
    }, 120_000);

    it('reproduce reports an over-cap plan in problems[] instead of creating a dead-end draft, and still reproduces a legal one', async () => {
      const legal = await draft({ n_trials: 3 });
      const ok = await http.post(`/experiments/${legal}/reproduce`).send({});
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ status: 'draft', n_trials: 3 });

      const tasks = (await prisma.task.findMany({ where: { isCurrent: true }, orderBy: { id: 'asc' }, take: 22 })).map((t) => t.id);
      const huge = await draft({ task_ids: tasks, n_trials: 1 });
      await prisma.experiment.update({ where: { id: huge }, data: { nTrials: 1000 } }); // a plan from before the cap: 44000 rows
      const before = await prisma.experiment.count();
      const res = await http.post(`/experiments/${huge}/reproduce`).send({});
      expect(res.status).toBe(409);
      expect(res.body.problems).toEqual([expect.stringMatching(/plan would be refused: 2 configs x 22 tasks x 1000 trials = 44000 trial rows/)]);
      expect(await prisma.experiment.count()).toBe(before);
    });

    it('refuses a phase downgrade full -> pilot with 409, and still lets pilot stay pilot', async () => {
      const full = await started({ phase: 'full' });
      const res = await http.post(`/experiments/${full}/extend`).send({ n_trials: 3, phase: 'pilot' });
      expect(res.status).toBe(409);
      expect(await trialCount(full)).toBe(16);
      expect((await prisma.experiment.findUniqueOrThrow({ where: { id: full } })).phase).toBe('full');
      const d = await draft({ phase: 'full' });
      expect((await http.post(`/experiments/${d}/extend`).send({ n_trials: 3, phase: 'pilot' })).status).toBe(409);
      const pilot = await started({ phase: 'pilot' });
      expect((await http.post(`/experiments/${pilot}/extend`).send({ n_trials: 3, phase: 'pilot' })).body.phase).toBe('pilot');
    });

    it('400 for a repeated or non-string query parameter on GET :id/trials, not a 500', async () => {
      const id = await started({ n_trials: 1 });
      expect((await http.get(`/experiments/${id}/trials?task_id=${TASKS[0]}&task_id=${TASKS[1]}`)).status).toBe(400);
      expect((await http.get(`/experiments/${id}/trials?config_id=${cfgA}&config_id=${cfgB}`)).status).toBe(400);
      expect((await http.get(`/experiments/${id}/trials?status=pending&status=done`)).status).toBe(400);
      expect((await http.get(`/experiments/${id}/trials?task_id=${TASKS[0]}&unknown=1`)).body).toHaveLength(2);
    });

    it('paused is reported for queued and running experiments only', async () => {
      const id = await started();
      const reason = 'circuit breaker: 5 consecutive terminal errors (last: config_invalid: x)';
      await prisma.experiment.update({ where: { id }, data: { pauseReason: reason } });
      expect((await http.get(`/experiments/${id}`)).body).toMatchObject({ status: 'queued', paused: true, pause_reason: reason });
      await prisma.experiment.update({ where: { id }, data: { status: 'running', startedAt: new Date() } });
      expect((await http.get(`/experiments/${id}`)).body.paused).toBe(true);
      await prisma.trial.updateMany({ where: { experimentId: id }, data: { status: 'done', passed: true, exitReason: 'completed' } });
      await prisma.experiment.update({ where: { id }, data: { status: 'completed', finishedAt: new Date() } });
      expect((await http.get(`/experiments/${id}`)).body.paused).toBe(false); // finished: nothing to resume
      expect((await http.get('/experiments')).body.find((e: { id: string }) => e.id === id).paused).toBe(false);
    });

    it('extend clears a pause_reason left on a finished experiment and resets the breaker count', async () => {
      const id = await started();
      await finishAll(id, 'partial');
      await prisma.experiment.update({ where: { id }, data: { pauseReason: 'circuit breaker: left over from the last run' } });
      jest.clearAllMocks();
      const res = await http.post(`/experiments/${id}/extend`).send({ n_trials: 3 });
      expect(res.body).toMatchObject({ status: 'running', pause_reason: null, paused: false });
      expect(scheduler.resetBreaker).toHaveBeenCalledWith(id);
    });

    it('extend of an experiment that was not finished leaves its breaker alone', async () => {
      const id = await started();
      jest.clearAllMocks();
      await http.post(`/experiments/${id}/extend`).send({ n_trials: 3 }).expect(200);
      expect(scheduler.resetBreaker).not.toHaveBeenCalled();
    });

    it('resume resets the breaker count BEFORE it clears pause_reason in the database', async () => {
      const id = await started();
      await prisma.experiment.update({ where: { id }, data: { status: 'running', startedAt: new Date(), pauseReason: 'circuit breaker: x' } });
      let reasonWhenReset: string | null | undefined;
      let seen!: Promise<void>;
      scheduler.resetBreaker.mockImplementationOnce(() => {
        seen = prisma.$queryRaw<{ pause_reason: string | null }[]>`SELECT pause_reason FROM experiment WHERE id = ${id}`.then((r) => {
          reasonWhenReset = r[0].pause_reason;
        });
        return undefined;
      });
      await http.post(`/experiments/${id}/resume`).expect(200);
      await seen;
      expect(scheduler.resetBreaker).toHaveBeenCalledWith(id);
      expect(reasonWhenReset).toBe('circuit breaker: x'); // still set when the count was reset
      expect((await prisma.experiment.findUniqueOrThrow({ where: { id } })).pauseReason).toBeNull();
    });

    it('logs a warning when the worker manifest cannot be recorded, and still creates and starts the experiment', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      worker.manifest = new Error('connection refused');
      const id = await draft();
      expect(warn.mock.calls.some((c) => /worker manifest not recorded.*connection refused/.test(String(c[0])))).toBe(true);
      await http.post(`/experiments/${id}/start`).expect(200); // start proceeds
      expect((await prisma.experiment.findUniqueOrThrow({ where: { id } })).workerManifest).toEqual({});
      warn.mockRestore();
    });

    it('cancel tells the worker about exactly the trials it cancelled while running, and closes their attempts', async () => {
      const id = await started({ n_trials: 1 });
      const rows = await prisma.trial.findMany({ where: { experimentId: id }, orderBy: { id: 'asc' } });
      const run = rows.slice(0, 3).map((t) => t.id);
      const now = new Date();
      await prisma.trial.updateMany({ where: { id: { in: run } }, data: { status: 'running', attemptCount: 1, startedAt: now, heartbeatAt: now } });
      await prisma.trialAttempt.createMany({ data: run.map((trialId) => ({ id: `att-r-${trialId}`, trialId, attemptNo: 1, startedAt: now })) });
      await prisma.experiment.update({ where: { id }, data: { status: 'running', startedAt: now } });
      await http.post(`/experiments/${id}/cancel`).expect(200);
      expect([...scheduler.cancelOnWorker.mock.calls[0][0]].sort()).toEqual([...run].sort());
      expect(await trialCount(id, { status: 'cancelled' })).toBe(rows.length);
      expect(await prisma.trialAttempt.count({ where: { trialId: { in: run }, result: 'cancelled' } })).toBe(3);
      expect(await prisma.trialAttempt.count({ where: { trialId: { in: run }, result: null } })).toBe(0);
    });
  });

  describe('a pinned task version must be the current one (the worker runs only the on-disk version)', () => {
    /** A draft pinned to hash-1 of a fresh task, plus a second pinned task that stays current. After `age()` hash-2 is the current version. */
    async function pinned() {
      const id = `tst-79-s${Date.now().toString(36)}${++counter}`;
      await insertTask(true, 'hash-1', id);
      const exp = await draft({ task_ids: [id, TASKS[0]], n_trials: 1 });
      const age = async () => {
        await prisma.task.update({ where: { id_versionHash: { id, versionHash: 'hash-1' } }, data: { isCurrent: false } });
        await insertTask(true, 'hash-2', id);
      };
      return { id, exp, age };
    }
    const problem = (id: string) => `task ${id} is pinned at hash-1 but the current version is hash-2; re-create the experiment`;

    it('start refuses with the stale pins, stays a draft and creates no trial', async () => {
      const { id, exp, age } = await pinned();
      await age();
      const res = await http.post(`/experiments/${exp}/start`);
      expect(res.status).toBe(409);
      expect(res.body.problems).toEqual([problem(id)]);
      expect(res.body.message).toContain(problem(id));
      expect((await prisma.experiment.findUniqueOrThrow({ where: { id: exp } })).status).toBe('draft');
      expect(await trialCount(exp)).toBe(0);
      expect(scheduler.kick).not.toHaveBeenCalled();
    });

    it('start still works when every pin is current, whatever other current rows exist', async () => {
      await insertTask(true); // an unrelated current task must not matter
      const { exp } = await pinned();
      expect((await http.post(`/experiments/${exp}/start`)).status).toBe(200);
      expect(await trialCount(exp)).toBe(4);
    });

    it('extend of a started experiment refuses, creates nothing and leaves n_trials alone', async () => {
      const { id, exp, age } = await pinned();
      await http.post(`/experiments/${exp}/start`).expect(200);
      await age();
      const res = await http.post(`/experiments/${exp}/extend`).send({ n_trials: 3 });
      expect(res.status).toBe(409);
      expect(res.body.problems).toEqual([problem(id)]);
      expect(await trialCount(exp)).toBe(4);
      expect((await prisma.experiment.findUniqueOrThrow({ where: { id: exp } })).nTrials).toBe(1);
    });

    it('extend of a draft only raises n_trials; the pins are checked when it starts', async () => {
      const { exp, age } = await pinned();
      await age();
      expect((await http.post(`/experiments/${exp}/extend`).send({ n_trials: 2 })).status).toBe(200);
      expect((await http.post(`/experiments/${exp}/start`)).status).toBe(409);
    });

    it('reproduce reports the stale pin in problems[] together with the other problems', async () => {
      const { id, exp, age } = await pinned();
      await http.post(`/experiments/${exp}/start`).expect(200);
      await age();
      worker.manifest = { ...MANIFEST, adapters: MANIFEST.adapters.map((a) => ({ ...a, version: `${a.version}-drift` })) };
      const res = await http.post(`/experiments/${exp}/reproduce`).send({});
      expect(res.status).toBe(409);
      expect(res.body.problems).toContain(problem(id));
      expect(res.body.problems.length).toBeGreaterThan(1);
    });
  });
});
