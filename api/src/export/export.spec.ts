/**
 * The export endpoints against the database: rows are inserted directly (test/helpers.ts, test/compare-fixtures.ts), the
 * HTTP layer is the real app. The end-to-end run through the scheduler is test/export.e2e.spec.ts.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { csvObjects, parseCsv } from '../../test/csv-parse';
import { CompareFixtures, EXACT_GRADER, JUDGE_GRADER } from '../../test/compare-fixtures';
import { Fixtures } from '../../test/helpers';
import { PrismaService } from '../prisma/prisma.service';
import { createTestApp, FakeWorker } from '../test-support/app';
import { ulid } from '../common/ulid';
import { CompareService } from '../compare/service';
import { COMPARE_CSV_COLUMNS, compareCsvOf, EXPORT_CSV_COLUMNS, MAX_TRACE_EXPORT_TRIALS } from './service';

const NASTY_NAME = 'config "A", the\nfirst';

describe('exports', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;
  let fx: Fixtures;
  let cf: CompareFixtures;
  let cfgA: string;
  let cfgB: string;
  let cfgC: string;
  /** 2 configs x 3 tasks x N=2, every trial done; B fails exa-02-ok both times. */
  let exp: { id: string; trialIds: string[] };
  const TASKS = ['exa-01-ok', 'exa-02-ok', 'exa-03-ok'];

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp(new FakeWorker()));
    http = request(app.getHttpServer());
    fx = new Fixtures(prisma);
    cf = new CompareFixtures(prisma, fx);
    const base = await fx.base();
    cfgA = await fx.config(base, NASTY_NAME);
    cfgB = await fx.config(base, 'config B');
    cfgC = await fx.config(base, 'config C');
    await cf.task(TASKS[0], 'neutral_deterministic', [EXACT_GRADER]);
    await cf.task(TASKS[1], 'honesty', [EXACT_GRADER]);
    await cf.task(TASKS[2], 'memory_dependent', [EXACT_GRADER]);

    exp = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: TASKS, nTrials: 2, status: 'running' });
    const rows = await prisma.trial.findMany({ where: { experimentId: exp.id } });
    for (const t of rows) {
      const passed = !(t.configId === cfgB && t.taskId === TASKS[1]);
      await cf.done(t.id, passed, { costUsd: 0.000058, latencyMs: 1500 });
    }
    await prisma.experiment.update({ where: { id: exp.id }, data: { status: 'completed', finishedAt: new Date() } });
  });

  afterAll(async () => {
    await cf.cleanup();
    await app.close();
  });

  const runsOf = (experimentId: string) => prisma.comparisonRun.findMany({ where: { experimentId }, orderBy: { id: 'asc' } });

  describe('export.csv', () => {
    it('has the exact header, 12 rows, text/csv, an attachment name and \\n line ends', async () => {
      const res = await http.get(`/experiments/${exp.id}/export.csv`).expect(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="[^"]+\.csv"$/);
      expect(res.text.startsWith(`${EXPORT_CSV_COLUMNS.join(',')}\n`)).toBe(true);
      expect(res.text).toContain('trial_id,config_id,config_name,task_id,task_category,trial_index,status,passed,exit_reason,steps,input_tokens,output_tokens,cost_usd,latency_ms,rate_limit_events,error_class\n');
      expect(res.text.endsWith('\n')).toBe(true);
      expect(res.text.includes('\r\n')).toBe(false);
      expect(parseCsv(res.text)).toHaveLength(13);
    });

    it('orders rows by config position, task id, trial index, and carries the category and values', async () => {
      const rows = csvObjects((await http.get(`/experiments/${exp.id}/export.csv`).expect(200)).text);
      const keys = rows.map((r) => `${r.config_id === cfgA ? 'A' : 'B'}/${r.task_id}/${r.trial_index}`);
      const expected = ['A', 'B'].flatMap((c) => TASKS.flatMap((t) => [0, 1].map((i) => `${c}/${t}/${i}`)));
      expect(keys).toEqual(expected);
      const first = rows[0];
      expect(first).toMatchObject({
        task_category: 'neutral_deterministic',
        status: 'done',
        passed: 'true',
        exit_reason: 'completed',
        steps: '2',
        input_tokens: '3000',
        output_tokens: '40',
        cost_usd: '0.000058',
        latency_ms: '1500',
        rate_limit_events: '0',
        error_class: '',
      });
      expect(rows.find((r) => r.task_id === TASKS[1] && r.config_id === cfgB)!.passed).toBe('false');
      expect(rows.find((r) => r.task_id === TASKS[1])!.task_category).toBe('honesty');
    });

    it('round-trips a config name with a comma, quotes and a newline', async () => {
      const rows = csvObjects((await http.get(`/experiments/${exp.id}/export.csv`).expect(200)).text);
      expect(NASTY_NAME).toMatch(/[",\n]/);
      expect(new Set(rows.filter((r) => r.config_id === cfgA).map((r) => r.config_name))).toEqual(new Set([NASTY_NAME]));
      expect(rows.every((r) => r.config_id === cfgA || r.config_name === 'config B')).toBe(true);
    });

    it('writes NULL as empty for pending, errored and cancelled trials, with the error class', async () => {
      const e = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: [TASKS[0]], nTrials: 2, status: 'running' });
      const [pending, errored, cancelled] = [e.trialIds[0], e.trialIds[1], e.trialIds[2]];
      await cf.errored(errored);
      await cf.cancelled(cancelled);
      const rows = csvObjects((await http.get(`/experiments/${e.id}/export.csv`).expect(200)).text);
      const by = (id: string) => rows.find((r) => r.trial_id === id)!;
      expect(by(pending)).toMatchObject({ status: 'pending', passed: '', exit_reason: '', steps: '', cost_usd: '', latency_ms: '', error_class: '' });
      expect(by(errored)).toMatchObject({ status: 'errored', passed: '', cost_usd: '', error_class: 'worker_crash' });
      expect(by(cancelled)).toMatchObject({ status: 'cancelled', error_class: 'cancelled' });
    });

    it('is the header alone for a draft with no trials, and 404s an unknown experiment', async () => {
      const created = await http.post('/experiments').send({ name: 'draft', config_ids: [cfgA, cfgB], task_ids: [TASKS[0]], n_trials: 2 }).expect(201);
      fx.track(created.body.id);
      const res = await http.get(`/experiments/${created.body.id}/export.csv`).expect(200);
      expect(res.text).toBe(`${EXPORT_CSV_COLUMNS.join(',')}\n`);
      await http.get('/experiments/NOPE/export.csv').expect(404);
    });
  });

  describe('compare.csv', () => {
    it('has the exact header, one row per task and a final __aggregate__ row, and stores a comparison_run', async () => {
      const before = (await runsOf(exp.id)).length;
      const res = await http.get(`/experiments/${exp.id}/compare.csv`).expect(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="[^"]+\.csv"$/);
      const records = parseCsv(res.text);
      expect(records[0]).toEqual([...COMPARE_CSV_COLUMNS]);
      expect(records[0].join(',')).toBe('task_id,category,n_a,n_b,rate_a,rate_b,delta,ci_low,ci_high,verdict');
      expect(records).toHaveLength(1 + 3 + 1);
      expect(records.slice(1, 4).map((r) => r[0])).toEqual(TASKS);
      expect(records[4][0]).toBe('__aggregate__');
      expect(records[4][1]).toBe('');

      const runs = await runsOf(exp.id);
      expect(runs).toHaveLength(before + 1);
    });

    it('matches the compare payload: rates, delta, n_a and n_b of the aggregate sum to n_scored', async () => {
      const payload = (await http.get(`/experiments/${exp.id}/compare`).expect(200)).body;
      const rows = csvObjects((await http.get(`/experiments/${exp.id}/compare.csv`).expect(200)).text);
      const agg = rows[rows.length - 1];
      expect(agg).toMatchObject({ task_id: '__aggregate__', category: '' });
      expect(Number(agg.n_a) + Number(agg.n_b)).toBe(payload.n_scored);
      expect(Number(agg.n_a)).toBe(6);
      expect(Number(agg.n_b)).toBe(6);
      expect(Number(agg.rate_a)).toBeCloseTo(payload.aggregate.p_a, 12);
      expect(Number(agg.rate_b)).toBeCloseTo(payload.aggregate.p_b, 12);
      expect(Number(agg.delta)).toBeCloseTo(payload.aggregate.delta, 12);
      expect(agg.verdict).toBe(payload.aggregate.verdict);
      const t2 = rows.find((r) => r.task_id === TASKS[1])!;
      expect(t2).toMatchObject({ category: 'honesty', n_a: '2', n_b: '2', rate_a: '1', rate_b: '0', delta: '1' });
      expect(Number(t2.delta)).toBe(payload.per_task.find((r: { task_id: string }) => r.task_id === TASKS[1]).delta);
    });

    it('honours a and b (swapping them flips the sign of the delta), and 400s a bad one', async () => {
      const ab = csvObjects((await http.get(`/experiments/${exp.id}/compare.csv?a=${cfgA}&b=${cfgB}`).expect(200)).text);
      const ba = csvObjects((await http.get(`/experiments/${exp.id}/compare.csv?a=${cfgB}&b=${cfgA}`).expect(200)).text);
      expect(Number(ab[ab.length - 1].delta)).toBeCloseTo(-Number(ba[ba.length - 1].delta), 12);
      await http.get(`/experiments/${exp.id}/compare.csv?a=${cfgA}&b=NOPE`).expect(400);
      await http.get(`/experiments/${exp.id}/compare.csv?a=${cfgA}&b=${cfgA}`).expect(400);
      await http.get('/experiments/NOPE/compare.csv').expect(404);
    });

    it('needs a and b when the experiment has 3 configs', async () => {
      const e = await fx.experiment({ configIds: [cfgA, cfgB, cfgC], taskIds: [TASKS[0]], nTrials: 1, status: 'running' });
      await http.get(`/experiments/${e.id}/compare.csv`).expect(400);
      await http.get(`/experiments/${e.id}/compare.csv?a=${cfgA}&b=${cfgC}`).expect(200);
    });

    it('builds the aggregate counts from the headline rows only (judge-excluded rows are shown but not counted)', () => {
      const row = (task_id: string, judge_excluded: boolean, n: number) => ({
        task_id,
        category: 'neutral_judged',
        n_a: n,
        n_b: n + 1,
        rate_a: 0.5,
        rate_b: 0.25,
        delta: 0.25,
        ci_low: null,
        ci_high: null,
        verdict: 'insufficient_data',
        direction_only: true,
        judge_excluded,
      });
      const csv = compareCsvOf({
        per_task: [row('x-01-a', false, 2), row('x-02-b', true, 5)],
        aggregate: { p_a: 0.5, p_b: 0.25, delta: 0.25, ci_low: null, ci_high: null, verdict: 'insufficient_data', min_detectable: null, resamples: 1, seed: 1 },
      } as never);
      const rows = parseCsv(csv);
      expect(rows).toHaveLength(4);
      expect(rows[3]).toEqual(['__aggregate__', '', '2', '3', '0.5', '0.25', '0.25', '', '', 'insufficient_data']);
      expect(rows[2][2]).toBe('5');
    });

    it('a judge_excluded row keeps its rates and delta, gets verdict judge_excluded and a blank interval even when the payload has one', () => {
      const base = { category: 'neutral_judged', n_a: 2, n_b: 2, rate_a: 0.5, rate_b: 1, delta: -0.5, ci_low: -1, ci_high: 0.25, direction_only: true };
      const csv = compareCsvOf({
        per_task: [
          { ...base, task_id: 'x-01-a', verdict: 'noise', judge_excluded: false },
          { ...base, task_id: 'x-02-j', verdict: 'noise', judge_excluded: true },
        ],
        aggregate: { p_a: 0.5, p_b: 1, delta: -0.5, ci_low: -1, ci_high: 0.25, verdict: 'noise', min_detectable: 0.6, resamples: 1, seed: 1 },
      } as never);
      const rows = csvObjects(csv);
      expect(rows[0]).toMatchObject({ task_id: 'x-01-a', ci_low: '-1', ci_high: '0.25', verdict: 'noise' });
      expect(rows[1]).toEqual({
        task_id: 'x-02-j',
        category: 'neutral_judged',
        n_a: '2',
        n_b: '2',
        rate_a: '0.5',
        rate_b: '1',
        delta: '-0.5',
        ci_low: '',
        ci_high: '',
        verdict: 'judge_excluded',
      });
      expect(rows[2]).toMatchObject({ task_id: '__aggregate__', n_a: '2', n_b: '2', ci_low: '-1', ci_high: '0.25', verdict: 'noise' });
    });

    it('an unpaired task gets a row between the task rows and the aggregate: category and counts from the info, blank rates and interval', () => {
      const csv = compareCsvOf(
        {
          per_task: [],
          unpaired_tasks: [
            { task_id: 'x-03-u', reason: 'no scored trial for config B' },
            { task_id: 'x-04-v', reason: 'no scored trial for either config' },
          ],
          aggregate: { p_a: null, p_b: null, delta: null, ci_low: null, ci_high: null, verdict: 'insufficient_data', min_detectable: null, resamples: 1, seed: 1 },
        } as never,
        new Map([['x-03-u', { category: 'honesty', n_a: 2, n_b: 0 }]]),
      );
      const rows = csvObjects(csv);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual({
        task_id: 'x-03-u',
        category: 'honesty',
        n_a: '2',
        n_b: '0',
        rate_a: '',
        rate_b: '',
        delta: '',
        ci_low: '',
        ci_high: '',
        verdict: 'unpaired',
      });
      expect(rows[1]).toMatchObject({ task_id: 'x-04-v', category: '', n_a: '', n_b: '', verdict: 'unpaired' }); // no info: blank, never invented
      expect(rows[2]).toMatchObject({ task_id: '__aggregate__', n_a: '0', n_b: '0', verdict: 'insufficient_data' });
    });

    it('over HTTP: an unpaired task has a row with its pinned category and the done-trial counts per side', async () => {
      const e = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: TASKS, nTrials: 2, status: 'running' });
      const trials = await prisma.trial.findMany({ where: { experimentId: e.id } });
      for (const t of trials) {
        if (t.taskId === TASKS[1] && t.configId === cfgB) await cf.errored(t.id); // B has no usable trial on task 2
        else await cf.done(t.id, true);
      }
      const rows = csvObjects((await http.get(`/experiments/${e.id}/compare.csv`).expect(200)).text);
      expect(rows.map((r) => r.task_id)).toEqual([TASKS[0], TASKS[2], TASKS[1], '__aggregate__']);
      expect(rows[2]).toEqual({
        task_id: TASKS[1],
        category: 'honesty',
        n_a: '2',
        n_b: '0',
        rate_a: '',
        rate_b: '',
        delta: '',
        ci_low: '',
        ci_high: '',
        verdict: 'unpaired',
      });
      // the aggregate row is unchanged by the unpaired row: only the 2 paired tasks enter it
      expect(rows[3]).toMatchObject({ category: '', n_a: '4', n_b: '4' });
      const payload = (await http.get(`/experiments/${e.id}/compare`).expect(200)).body;
      expect(Number(rows[3].n_a) + Number(rows[3].n_b)).toBe(payload.n_scored);
    });

    it('over HTTP: a judge-excluded task has verdict judge_excluded, blank ci_low and ci_high, and keeps its rates and delta', async () => {
      await cf.task('exa-15-judge', 'neutral_judged', [JUDGE_GRADER]);
      const e = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: [TASKS[0], 'exa-15-judge'], nTrials: 2, status: 'running' });
      for (const t of await prisma.trial.findMany({ where: { experimentId: e.id } })) {
        // mixed outcomes on both sides, so the payload carries a real (non-null) interval for the judged task
        await cf.done(t.id, t.configId === cfgA ? t.trialIndex === 0 : true);
      }
      const payload = (await http.get(`/experiments/${e.id}/compare`).expect(200)).body;
      const judged = payload.per_task.find((r: { task_id: string }) => r.task_id === 'exa-15-judge');
      expect(payload.judge_policy_applied).toBe('excluded');
      expect(judged).toMatchObject({ judge_excluded: true, rate_a: 0.5, rate_b: 1, delta: -0.5 });
      expect(judged.ci_low).not.toBeNull(); // the payload has the interval, the CSV withholds it

      const rows = csvObjects((await http.get(`/experiments/${e.id}/compare.csv`).expect(200)).text);
      const row = rows.find((r) => r.task_id === 'exa-15-judge')!;
      expect(row).toMatchObject({ category: 'neutral_judged', n_a: '2', n_b: '2', rate_a: '0.5', rate_b: '1', delta: '-0.5', ci_low: '', ci_high: '', verdict: 'judge_excluded' });
      const plain = rows.find((r) => r.task_id === TASKS[0])!;
      expect(plain.verdict).not.toBe('judge_excluded');
      expect(plain.ci_low).not.toBe('');
      expect(rows[rows.length - 1]).toMatchObject({ task_id: '__aggregate__', n_a: '2', n_b: '2' }); // the judged task is not in the headline
    });

    it('404s an id with a NUL byte on all three endpoints', async () => {
      for (const path of ['export.json', 'export.csv', 'compare.csv']) await http.get(`/experiments/%00/${path}`).expect(404);
    });
  });

  describe('export.json', () => {
    it('has experiment, configs, tasks, trials with grader_results, and comparison_runs; stores a comparison_run for 2 configs', async () => {
      const before = (await runsOf(exp.id)).length; // the compare.csv tests above stored the comparison of this unchanged experiment
      expect(before).toBeGreaterThan(0);
      const res = await http.get(`/experiments/${exp.id}/export.json`).expect(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="[^"]+\.json"$/);
      const body = res.body;
      expect(Object.keys(body)).toEqual(['experiment', 'configs', 'tasks', 'trials', 'comparison_runs', 'comparison_run_id']);
      expect(body.experiment).toMatchObject({ id: exp.id, status: 'completed', n_trials: 2 });
      expect(body.configs.map((c: { id: string; name: string; position: number }) => [c.id, c.name, c.position])).toEqual([
        [cfgA, NASTY_NAME, 0],
        [cfgB, 'config B', 1],
      ]);
      expect(body.configs[0].settings.max_steps).toBe(15);
      expect(body.tasks.map((t: { task_id: string }) => t.task_id)).toEqual(TASKS);
      expect(body.tasks[0]).toMatchObject({ category: 'neutral_deterministic', graders: [EXACT_GRADER] });
      expect(body.trials).toHaveLength(12);
      expect(body.trials[0]).toMatchObject({ config_id: cfgA, task_id: TASKS[0], trial_index: 0, status: 'done', cost_usd: 0.000058 });
      expect(body.trials[0].grader_results).toEqual([]); // inserted without a grader row: the key is still there
      // the experiment did not change since the last stored comparison, so the export reuses that row instead of adding one
      expect(body.comparison_runs).toHaveLength(before);
      const used = body.comparison_runs.find((r: { id: string }) => r.id === body.comparison_run_id);
      expect(used).toMatchObject({ config_a_id: cfgA, config_b_id: cfgB, stats_version: expect.any(String), resamples: 10000 });
    });

    it('includes a trial\'s grader_results ordered by grader_index', async () => {
      const e = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: [TASKS[0]], nTrials: 1, status: 'running' });
      await cf.done(e.trialIds[0], true);
      await prisma.graderResult.createMany({
        data: [1, 0].map((i) => ({ id: ulid(), trialId: e.trialIds[0], graderIndex: i, graderType: 'exact_match' as const, passed: true, details: { i }, durationMs: 1 })),
      });
      const t = (await http.get(`/experiments/${e.id}/export.json`).expect(200)).body.trials.find((x: { id: string }) => x.id === e.trialIds[0]);
      expect(t.grader_results.map((g: { grader_index: number }) => g.grader_index)).toEqual([0, 1]);
      expect(t.grader_results[0]).toMatchObject({ grader_type: 'exact_match', passed: true, details: { i: 0 }, duration_ms: 1 });
    });

    it('stores a comparison_run whose result equals GET compare; a repeated export of an unchanged experiment reuses the row', async () => {
      const e = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: TASKS, nTrials: 1, status: 'running' });
      for (const id of e.trialIds) await cf.done(id, true);
      await prisma.experiment.update({ where: { id: e.id }, data: { status: 'completed', finishedAt: new Date() } });

      const first = (await http.get(`/experiments/${e.id}/export.json`).expect(200)).body;
      expect(first.comparison_runs).toHaveLength(1);
      expect(first.comparison_run_id).toBe(first.comparison_runs[0].id);
      const compared = (await http.get(`/experiments/${e.id}/compare`).expect(200)).body;
      expect(first.comparison_runs[0].result).toEqual(compared);

      const second = (await http.get(`/experiments/${e.id}/export.json`).expect(200)).body;
      expect(second.comparison_runs).toHaveLength(1);
      expect(second.comparison_run_id).toBe(first.comparison_run_id);
      expect(await runsOf(e.id)).toHaveLength(1);
    });

    it('an export after the experiment changed adds a row, names it in comparison_run_id, and keeps the older row', async () => {
      const e = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: TASKS, nTrials: 1, status: 'running' });
      for (const id of e.trialIds) await cf.done(id, true);
      const first = (await http.get(`/experiments/${e.id}/export.json`).expect(200)).body;

      await prisma.trial.update({ where: { id: e.trialIds[0] }, data: { passed: false } });
      const second = (await http.get(`/experiments/${e.id}/export.json`).expect(200)).body;
      expect(second.comparison_runs).toHaveLength(2);
      expect(second.comparison_run_id).not.toBe(first.comparison_run_id);
      expect(second.comparison_run_id).toBe(second.comparison_runs[1].id);
      expect(second.comparison_runs[0].id).toBe(first.comparison_run_id);
      expect(second.comparison_runs[1].result).not.toEqual(second.comparison_runs[0].result);
      expect(second.comparison_runs[1].result).toEqual((await http.get(`/experiments/${e.id}/compare`).expect(200)).body);
    });

    it('reads the trials and the comparison from ONE snapshot: a trial that settles in between shows in neither', async () => {
      const e = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: TASKS, nTrials: 1, status: 'running' });
      for (const id of e.trialIds) await cf.done(id, true);
      const victim = e.trialIds[0];
      const service = app.get(CompareService);
      const real = service.compute.bind(service);
      let flipped = false;
      const spy = jest.spyOn(service, 'compute').mockImplementation(async (...args: Parameters<CompareService['compute']>) => {
        if (!flipped) {
          flipped = true;
          // another connection commits a changed trial after the export's snapshot began and before the comparison runs
          await prisma.trial.update({ where: { id: victim }, data: { passed: false } });
        }
        return real(...args);
      });
      let snapshot;
      try {
        snapshot = (await http.get(`/experiments/${e.id}/export.json`).expect(200)).body;
      } finally {
        spy.mockRestore();
      }
      expect(flipped).toBe(true);
      expect((await prisma.trial.findUniqueOrThrow({ where: { id: victim } })).passed).toBe(false); // the change did commit
      // the export shows the state it started from, in the trials AND in the stored comparison
      expect(snapshot.trials.find((t: { id: string }) => t.id === victim).passed).toBe(true);
      const run = snapshot.comparison_runs[0].result;
      expect(run.aggregate.p_a).toBe(1);
      expect(run.aggregate.p_b).toBe(1);
      expect(snapshot.comparison_run_id).toBe(snapshot.comparison_runs[0].id);
      // a fresh export sees the committed change
      const after = (await http.get(`/experiments/${e.id}/export.json`).expect(200)).body;
      expect(after.trials.find((t: { id: string }) => t.id === victim).passed).toBe(false);
      expect(after.comparison_run_id).not.toBe(snapshot.comparison_run_id);
    });

    it('leaves traces out by default and includes them with ?traces=1 (the stored trace, or the partial events of an errored trial)', async () => {
      const e = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: [TASKS[0]], nTrials: 1, status: 'running' });
      const [withTrace, errored] = e.trialIds;
      await cf.done(withTrace, true);
      await prisma.trace.create({
        data: {
          trialId: withTrace,
          harnessId: 'h',
          harnessVersion: 'v1',
          modelSlug: 'm/s',
          events: [{ seq: 0, kind: 'message' }],
          memoryInitial: {},
          memoryFinal: {},
          skillsInvoked: [],
          notes: [],
          finalResponse: 'FINAL: 8081',
        },
      });
      await cf.errored(errored);
      await prisma.trialAttempt.create({
        data: { id: ulid(), trialId: errored, attemptNo: 1, startedAt: new Date(), result: 'errored', errorClass: 'worker_crash', errorMessage: 'scripted', partialTrace: [{ seq: 0, kind: 'api_call' }] },
      });

      const plain = (await http.get(`/experiments/${e.id}/export.json`).expect(200)).body;
      for (const t of plain.trials) expect(Object.keys(t)).not.toContain('trace');
      expect(JSON.stringify(plain)).not.toContain('FINAL: 8081');

      const traced = (await http.get(`/experiments/${e.id}/export.json?traces=1`).expect(200)).body;
      const byId = (id: string) => traced.trials.find((t: { id: string }) => t.id === id);
      expect(byId(withTrace).trace).toMatchObject({ trial_id: withTrace, final_response: 'FINAL: 8081', events: [{ seq: 0, kind: 'message' }], model_slug: 'm/s' });
      expect(byId(errored).trace).toMatchObject({ partial: true, error_class: 'worker_crash', events: [{ seq: 0, kind: 'api_call' }] });

      const off = (await http.get(`/experiments/${e.id}/export.json?traces=0`).expect(200)).body;
      expect(Object.keys(off.trials[0])).not.toContain('trace');
      await http.get(`/experiments/${e.id}/export.json?traces=yes`).expect(400);
    });

    it(`?traces=1 is refused with 400 above ${MAX_TRACE_EXPORT_TRIALS} trials; without traces the same experiment exports`, async () => {
      // 2 configs x 1 task x 1001 trials = 2002 trials
      const e = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: [TASKS[0]], nTrials: 1001, status: 'running' });
      expect(await prisma.trial.count({ where: { experimentId: e.id } })).toBe(2002);
      const refused = await http.get(`/experiments/${e.id}/export.json?traces=1`).expect(400);
      expect(refused.body.message).toContain(String(MAX_TRACE_EXPORT_TRIALS));
      expect(await runsOf(e.id)).toHaveLength(0); // refused before the comparison was computed
      const plain = await http.get(`/experiments/${e.id}/export.json`).expect(200);
      expect(plain.body.trials).toHaveLength(2002);
    });

    it('with 3 configs and no a/b computes no comparison and lists what is stored; with a and b it stores one', async () => {
      const e = await fx.experiment({ configIds: [cfgA, cfgB, cfgC], taskIds: TASKS, nTrials: 1, status: 'running' });
      for (const id of e.trialIds) await cf.done(id, true);
      const none = (await http.get(`/experiments/${e.id}/export.json`).expect(200)).body;
      expect(none.trials).toHaveLength(9);
      expect(none.comparison_runs).toEqual([]);
      expect(none.comparison_run_id).toBeNull();
      expect(await runsOf(e.id)).toHaveLength(0);

      const one = (await http.get(`/experiments/${e.id}/export.json?a=${cfgA}&b=${cfgC}`).expect(200)).body;
      expect(one.comparison_runs).toHaveLength(1);
      expect(one.comparison_runs[0]).toMatchObject({ config_a_id: cfgA, config_b_id: cfgC });
      expect(one.comparison_run_id).toBe(one.comparison_runs[0].id);
      const again = (await http.get(`/experiments/${e.id}/export.json`).expect(200)).body; // no a/b: lists, stores nothing
      expect(again.comparison_runs).toHaveLength(1);
      expect(again.comparison_run_id).toBeNull(); // nothing was computed by this export
    });

    it('400s a bad or incomplete a/b without storing anything, and 404s an unknown experiment', async () => {
      const e = await fx.experiment({ configIds: [cfgA, cfgB, cfgC], taskIds: [TASKS[0]], nTrials: 1, status: 'running' });
      await http.get(`/experiments/${e.id}/export.json?a=${cfgA}`).expect(400); // 3 configs: both are needed
      await http.get(`/experiments/${exp.id}/export.json?a=NOPE&b=${cfgB}`).expect(400);
      await http.get(`/experiments/${exp.id}/export.json?a=${cfgA}&b=${cfgA}`).expect(400);
      await http.get(`/experiments/${exp.id}/export.json?a=${cfgA}&a=${cfgB}`).expect(400);
      expect(await runsOf(e.id)).toHaveLength(0);
      await http.get('/experiments/NOPE/export.json').expect(404);
    });

    it('a judged task with no judge validation is excluded from the comparison the export stores (D-16), and the aggregate row says so', async () => {
      await cf.task('exa-14-judge', 'neutral_judged', [JUDGE_GRADER]);
      const e = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: [...TASKS, 'exa-14-judge'], nTrials: 1, status: 'running' });
      for (const id of e.trialIds) await cf.done(id, true);
      const body = (await http.get(`/experiments/${e.id}/export.json`).expect(200)).body;
      expect(body.comparison_runs[0].judge_policy_applied).toBe('excluded');
      expect(body.comparison_runs[0].result.judge_excluded_tasks).toEqual(['exa-14-judge']);
      const rows = csvObjects((await http.get(`/experiments/${e.id}/compare.csv`).expect(200)).text);
      expect(rows).toHaveLength(5); // the judged task keeps its row; the aggregate leaves it out
      const agg = rows[rows.length - 1];
      expect(Number(agg.n_a)).toBe(3);
      expect(Number(agg.n_b)).toBe(3);
    });
  });
});
