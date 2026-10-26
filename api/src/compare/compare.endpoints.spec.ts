import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CompareFixtures, EXACT_GRADER, JUDGE_GRADER, keysDeep } from '../../test/compare-fixtures';
import { createExperimentsApp } from '../../test/experiments-app';
import { Fixtures } from '../../test/helpers';
import { ulid } from '../common/ulid';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { STATS_VERSION } from '../stats/version';
import { hasJudgeGrader } from './service';

/** Compare and pilot endpoints against the real database: trials are inserted already finished, no dispatch happens. */
describe('GET /experiments/:id/compare and /pilot (P3 S4)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: Fixtures;
  let cf: CompareFixtures;
  let cfgA: string;
  let cfgB: string;
  let cfgC: string;
  const PLAIN = ['cmq-01-a', 'cmq-02-a', 'cmq-03-a'];
  const JUDGED = 'cmq-04-j';

  beforeAll(async () => {
    ({ app, prisma } = await createExperimentsApp());
    fx = new Fixtures(prisma);
    cf = new CompareFixtures(prisma, fx);
    const base = await fx.base();
    cfgA = await fx.config(base, 'config A');
    cfgB = await fx.config(base, 'config B');
    cfgC = await fx.config(base, 'config C');
    for (const id of PLAIN) await cf.task(id, 'neutral_deterministic', [EXACT_GRADER]);
    await cf.task(JUDGED, 'neutral_judged', [EXACT_GRADER, JUDGE_GRADER]);
  });

  afterAll(async () => {
    await cf.cleanup();
    await app.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);
  const tag = () => ulid().toLowerCase();

  /** 2 configs x (3 plain + 1 judged) x N = 1, every trial done: A passes everything, B only the first plain task. */
  async function seed(opts: { configs?: string[]; tasks?: string[]; finish?: boolean } = {}) {
    const configs = opts.configs ?? [cfgA, cfgB];
    const ex = await fx.experiment({ configIds: configs, taskIds: opts.tasks ?? [...PLAIN, JUDGED], nTrials: 1, status: 'running', seed: 7 });
    const trials = await prisma.trial.findMany({ where: { experimentId: ex.id } });
    if (opts.finish !== false) {
      for (const t of trials) await cf.done(t.id, t.configId === cfgA || t.taskId === PLAIN[0]);
    }
    return { id: ex.id, trials };
  }
  const judgedTrialIds = (trials: { id: string; taskId: string }[]) => trials.filter((t) => t.taskId === JUDGED).map((t) => t.id);

  describe('failure categories (P6)', () => {
    it('counts the stored categories of each side, per category and per task', async () => {
      const ex = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: PLAIN, nTrials: 1, status: 'running', seed: 7 });
      const trials = await prisma.trial.findMany({ where: { experimentId: ex.id } });
      const of = (cfg: string, task: string) => trials.find((t) => t.configId === cfg && t.taskId === task)!.id;
      await cf.done(of(cfgA, PLAIN[0]), false, { failureCategory: 'step_exhaustion' });
      await cf.done(of(cfgA, PLAIN[1]), false, { failureCategory: 'step_exhaustion' });
      await cf.done(of(cfgA, PLAIN[2]), true);
      await cf.done(of(cfgB, PLAIN[0]), true);
      await cf.done(of(cfgB, PLAIN[1]), false, { failureCategory: 'memory_ignored' });
      await cf.done(of(cfgB, PLAIN[2]), false); // wrong_answer, the fixture default
      const body = (await get(`/experiments/${ex.id}/compare?a=${cfgA}&b=${cfgB}`).expect(200)).body;
      expect(body.failures.a).toMatchObject({ step_exhaustion: 2, memory_ignored: 0, wrong_answer: 0 });
      expect(body.failures.b).toMatchObject({ step_exhaustion: 0, memory_ignored: 1, wrong_answer: 1 });
      expect(Object.keys(body.failures.a)).toHaveLength(12);
      expect(body.failures.uncategorized).toEqual({ a: 0, b: 0 });
      const row = (task: string) => body.per_task.find((r: { task_id: string }) => r.task_id === task);
      expect([row(PLAIN[0]).failure_category_a, row(PLAIN[0]).failure_category_b]).toEqual(['step_exhaustion', null]);
      expect([row(PLAIN[1]).failure_category_a, row(PLAIN[1]).failure_category_b]).toEqual(['step_exhaustion', 'memory_ignored']);
      expect([row(PLAIN[2]).failure_category_a, row(PLAIN[2]).failure_category_b]).toEqual([null, 'wrong_answer']);
      // the same numbers come back from the stored comparison_run
      const stored = (await get(`/experiments/${ex.id}/compare?a=${cfgA}&b=${cfgB}&persist=1`).expect(200)).body;
      const run = await prisma.comparisonRun.findUniqueOrThrow({ where: { id: stored.comparison_run_id } });
      expect((run.result as { failures: unknown }).failures).toEqual(body.failures);
      expect(body.failures_judge_excluded).toBeNull(); // no judged task in this experiment: the policy is trusted
      expect((run.result as { failures_judge_excluded: unknown }).failures_judge_excluded).toBeNull();
    });

    /** A on the plain task fails 'step_exhaustion', B passes; both configs fail the judged task 'judge_criteria_unmet'. */
    async function judgedExperiment() {
      const ex = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: [PLAIN[0], JUDGED], nTrials: 1, status: 'running', seed: 7 });
      const trials = await prisma.trial.findMany({ where: { experimentId: ex.id } });
      const of = (cfg: string, task: string) => trials.find((t) => t.configId === cfg && t.taskId === task)!.id;
      await cf.done(of(cfgA, PLAIN[0]), false, { failureCategory: 'step_exhaustion' });
      await cf.done(of(cfgB, PLAIN[0]), true);
      await cf.done(of(cfgA, JUDGED), false, { failureCategory: 'judge_criteria_unmet' });
      await cf.done(of(cfgB, JUDGED), false, { failureCategory: 'judge_criteria_unmet' });
      return { id: ex.id, judgedTrialIds: [of(cfgA, JUDGED), of(cfgB, JUDGED)] };
    }
    const compareAndStored = async (id: string) => {
      const body = (await get(`/experiments/${id}/compare?a=${cfgA}&b=${cfgB}`).expect(200)).body;
      const stored = (await get(`/experiments/${id}/compare?a=${cfgA}&b=${cfgB}&persist=1`).expect(200)).body;
      const run = await prisma.comparisonRun.findUniqueOrThrow({ where: { id: stored.comparison_run_id } });
      return { body, result: run.result as { failures: unknown; failures_judge_excluded: unknown } };
    };

    it('under the judge policy excluded the failures of the judged task are in failures_judge_excluded only, in the payload and in the stored run', async () => {
      const { id } = await judgedExperiment(); // no judge grader rows yet: policy excluded
      const { body, result } = await compareAndStored(id);
      expect(body.judge_policy_applied).toBe('excluded');
      expect(body.failures.a).toMatchObject({ step_exhaustion: 1, judge_criteria_unmet: 0 });
      expect(body.failures.b).toMatchObject({ step_exhaustion: 0, judge_criteria_unmet: 0 });
      expect(body.failures_judge_excluded.a).toMatchObject({ step_exhaustion: 0, judge_criteria_unmet: 1 });
      expect(body.failures_judge_excluded.b).toMatchObject({ judge_criteria_unmet: 1 });
      expect(Object.keys(body.failures_judge_excluded.a)).toHaveLength(12);
      expect(body.failures_judge_excluded.uncategorized).toEqual({ a: 0, b: 0 });
      expect(body.n_scored).toBe(2); // the headline is unchanged: only the plain task
      expect(result.failures).toEqual(body.failures);
      expect(result.failures_judge_excluded).toEqual(body.failures_judge_excluded);
    });

    it('under a trusted judge the judged task is in failures and failures_judge_excluded is null', async () => {
      const { id, judgedTrialIds: judged } = await judgedExperiment();
      const m = `cmq-judge-${tag()}`;
      await cf.judgeRows(judged.slice(0, 1), m, 'prompt-1');
      await cf.validation({ modelId: m, promptHash: 'prompt-1', kappa: 0.7 });
      const { body, result } = await compareAndStored(id);
      expect(body.judge_policy_applied).toBe('trusted');
      expect(body.failures.a).toMatchObject({ step_exhaustion: 1, judge_criteria_unmet: 1 });
      expect(body.failures.b).toMatchObject({ judge_criteria_unmet: 1 });
      expect(body.failures_judge_excluded).toBeNull();
      expect(result.failures).toEqual(body.failures);
      expect(result.failures_judge_excluded).toBeNull();
    });

    it('the failed trials of an unpaired task are counted in failures (B has no scored trial there)', async () => {
      const ex = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: PLAIN.slice(0, 2), nTrials: 1, status: 'running', seed: 7 });
      const trials = await prisma.trial.findMany({ where: { experimentId: ex.id } });
      const of = (cfg: string, task: string) => trials.find((t) => t.configId === cfg && t.taskId === task)!.id;
      await cf.done(of(cfgA, PLAIN[0]), true);
      await cf.done(of(cfgB, PLAIN[0]), true);
      await cf.done(of(cfgA, PLAIN[1]), false, { failureCategory: 'timeout' });
      await cf.errored(of(cfgB, PLAIN[1]));
      const { body, result } = await compareAndStored(ex.id);
      expect(body.unpaired_tasks.map((u: { task_id: string }) => u.task_id)).toEqual([PLAIN[1]]);
      expect(body.failures.a).toMatchObject({ timeout: 1 });
      expect(body.n_scored).toBe(2);
      expect(result.failures).toEqual(body.failures);
    });

    it('a trial and the trial list carry failure_category and failure_evidence', async () => {
      const ex = await fx.experiment({ configIds: [cfgA], taskIds: [PLAIN[0], PLAIN[1]], nTrials: 1, status: 'running', seed: 7 });
      const trials = await prisma.trial.findMany({ where: { experimentId: ex.id } });
      await cf.done(trials[0].id, false, { failureCategory: 'timeout' });
      await cf.done(trials[1].id, true);
      const one = (await get(`/trials/${trials[0].id}`).expect(200)).body;
      expect(one).toMatchObject({ passed: false, failure_category: 'timeout', failure_evidence: { rule: 10, category: 'timeout' } });
      expect(await get(`/trials/${trials[1].id}`).expect(200).then((r) => [r.body.failure_category, r.body.failure_evidence])).toEqual([null, null]);
      const list = (await get(`/experiments/${ex.id}/trials`).expect(200)).body as Array<{ id: string; failure_category: string | null }>;
      expect(Object.fromEntries(list.map((t) => [t.id, t.failure_category]))).toEqual({ [trials[0].id]: 'timeout', [trials[1].id]: null });
    });
  });

  describe('errors', () => {
    it('404 for an unknown experiment on both routes', async () => {
      await get('/experiments/nope/compare').expect(404);
      await get('/experiments/nope/pilot').expect(404);
    });

    it('404, not 500, for an id with a NUL byte or an absurd length (ExperimentIdPipe)', async () => {
      await get('/experiments/%00/compare').expect(404);
      await get('/experiments/%00/pilot').expect(404);
      await get('/experiments/ab%00cd/compare?persist=1').expect(404);
      await get(`/experiments/${'x'.repeat(65)}/compare`).expect(404);
    });

    it('400 when a and b are missing and the experiment has 3 configs, or only one is given', async () => {
      const { id } = await seed({ configs: [cfgA, cfgB, cfgC], tasks: PLAIN });
      await get(`/experiments/${id}/compare`).expect(400);
      await get(`/experiments/${id}/compare?a=${cfgA}`).expect(400);
      await get(`/experiments/${id}/compare?b=${cfgB}`).expect(400);
      await get(`/experiments/${id}/compare?a=${cfgA}&b=${cfgC}`).expect(200);
    });

    it('400 for a config that is not in the experiment, for a === b, for a bad persist flag and for repeated parameters', async () => {
      const { id } = await seed({ tasks: PLAIN });
      await get(`/experiments/${id}/compare?a=${cfgA}&b=${ulid()}`).expect(400);
      await get(`/experiments/${id}/compare?a=${ulid()}&b=${cfgB}`).expect(400);
      await get(`/experiments/${id}/compare?a=${cfgC}&b=${cfgB}`).expect(400); // exists, but not in this experiment
      await get(`/experiments/${id}/compare?a=${cfgA}&b=${cfgA}`).expect(400);
      await get(`/experiments/${id}/compare?persist=maybe`).expect(400);
      await get(`/experiments/${id}/compare?a=${cfgA}&a=${cfgB}&b=${cfgB}`).expect(400);
      expect(await prisma.comparisonRun.count({ where: { experimentId: id } })).toBe(0);
    });
  });

  describe('a and b', () => {
    it('default to the first 2 configs by position when the experiment has exactly 2', async () => {
      const { id } = await seed({ configs: [cfgB, cfgA], tasks: PLAIN }); // position order, not creation order
      const res = await get(`/experiments/${id}/compare`).expect(200);
      expect(res.body.config_a).toEqual({ id: cfgB, name: 'config B' });
      expect(res.body.config_b).toEqual({ id: cfgA, name: 'config A' });
      expect(res.body.experiment_id).toBe(id);
      expect(res.body.stats_version).toBe(STATS_VERSION);
    });

    it('explicit a and b swap the sides; one of them given means the other is the remaining config', async () => {
      const { id } = await seed({ tasks: PLAIN });
      const swapped = await get(`/experiments/${id}/compare?a=${cfgB}&b=${cfgA}`).expect(200);
      expect(swapped.body.config_a.id).toBe(cfgB);
      expect(swapped.body.config_b.id).toBe(cfgA);
      expect(swapped.body.aggregate.delta).toBeCloseTo(-(await get(`/experiments/${id}/compare`).expect(200)).body.aggregate.delta, 12);
      const onlyB = await get(`/experiments/${id}/compare?b=${cfgA}`).expect(200);
      expect([onlyB.body.config_a.id, onlyB.body.config_b.id]).toEqual([cfgB, cfgA]);
    });

    it('pairs 2 of 3 configs and ignores the third config trials', async () => {
      const { id } = await seed({ configs: [cfgA, cfgB, cfgC], tasks: PLAIN });
      const res = await get(`/experiments/${id}/compare?a=${cfgA}&b=${cfgC}`).expect(200);
      expect(res.body.n_scored).toBe(6);
      expect(res.body.config_b.id).toBe(cfgC);
    });
  });

  describe('judge policy (DESIGN 8.3, 8.4, D-16)', () => {
    it('judged task detection: true iff the pinned task graders include llm_judge', () => {
      expect(hasJudgeGrader([EXACT_GRADER])).toBe(false);
      expect(hasJudgeGrader([EXACT_GRADER, JUDGE_GRADER])).toBe(true);
      expect(hasJudgeGrader({ type: 'llm_judge' })).toBe(false);
      expect(hasJudgeGrader(null)).toBe(false);
    });

    it('no judged task in the pinned set: trusted, judge.model_id null, even when validation rows exist for other judges', async () => {
      const m = `cmq-judge-${tag()}`;
      await cf.validation({ modelId: m, promptHash: 'p1', kappa: 0.1 });
      const { id } = await seed({ tasks: PLAIN });
      const { body } = await get(`/experiments/${id}/compare`).expect(200);
      expect(body.judge_policy_applied).toBe('trusted');
      expect(body.judge).toEqual({ model_id: null, prompt_hash: null, kappa: null, policy: 'trusted' });
      expect(body.judge_confidence).toBeNull();
      expect(body.judge_excluded_tasks).toEqual([]);
    });

    it('judged tasks but no judge grader rows yet: excluded, model null', async () => {
      const { id } = await seed({ finish: false });
      const { body } = await get(`/experiments/${id}/compare`).expect(200);
      expect(body.judge_policy_applied).toBe('excluded');
      expect(body.judge.model_id).toBeNull();
      expect(body.judge_excluded_tasks).toEqual([JUDGED]);
    });

    it('judge rows but no judge_validation row: excluded, and the judged task is not in the aggregate', async () => {
      const { id, trials } = await seed();
      const m = `cmq-judge-${tag()}`;
      await cf.judgeRows(judgedTrialIds(trials).slice(0, 2), m, 'prompt-1');
      const { body } = await get(`/experiments/${id}/compare`).expect(200);
      expect(body.judge_policy_applied).toBe('excluded');
      expect(body.judge).toMatchObject({ model_id: m, prompt_hash: 'prompt-1', kappa: null, policy: 'excluded' });
      expect(body.judge_excluded_tasks).toEqual([JUDGED]);
      expect(body.n_scored).toBe(6);
      expect(body.per_task.find((r: { task_id: string }) => r.task_id === JUDGED).judge_excluded).toBe(true);
      expect(body.judge_confidence).toBeNull();
    });

    // Each case: the judge gets 1 validation row and its tagged grader rows are written on the judged trials.
    it.each([
      [0.7, 'trusted', 8, null, []],
      [0.5, 'flagged', 8, 'low', []],
      [0.2, 'excluded', 6, null, [JUDGED]],
    ] as const)('kappa %s gives %s', async (kappa, policy, nScored, confidence, excludedTasks) => {
      const { id, trials } = await seed();
      const m = `cmq-judge-${tag()}`;
      await cf.judgeRows(judgedTrialIds(trials).slice(0, 1), m, 'prompt-1');
      await cf.validation({ modelId: m, promptHash: 'prompt-1', kappa });
      const { body } = await get(`/experiments/${id}/compare`).expect(200);
      expect(body.judge_policy_applied).toBe(policy);
      expect(body.judge).toEqual({ model_id: m, prompt_hash: 'prompt-1', kappa, policy });
      expect(body.judge_confidence).toBe(confidence);
      expect(body.judge_excluded_tasks).toEqual(excludedTasks);
      expect(body.n_scored).toBe(nScored);
      const row = body.per_task.find((r: { task_id: string }) => r.task_id === JUDGED);
      expect(row.judge_excluded).toBe(policy === 'excluded');
    });

    it('2 judges: the most restrictive policy wins and its judge is reported', async () => {
      const { id, trials } = await seed();
      const j = judgedTrialIds(trials);
      const good = `cmq-judge-${tag()}`;
      const meh = `cmq-judge-${tag()}`;
      await cf.judgeRows([j[0]], good, 'prompt-1');
      await cf.validation({ modelId: good, promptHash: 'prompt-1', kappa: 0.8 });
      // A trial has 1 judge row at grader_index 0, so the second judge tags the other judged trial.
      await cf.judgeRows([j[1]], meh, 'prompt-2');
      await cf.validation({ modelId: meh, promptHash: 'prompt-2', kappa: 0.45 });
      const { body } = await get(`/experiments/${id}/compare`).expect(200);
      expect(body.judge_policy_applied).toBe('flagged');
      expect(body.judge).toEqual({ model_id: meh, prompt_hash: 'prompt-2', kappa: 0.45, policy: 'flagged' });
      expect(body.judge_confidence).toBe('low');

      // A third pair with no validation row makes it excluded.
      const third = await prisma.trial.findFirstOrThrow({ where: { experimentId: id, taskId: PLAIN[0], configId: cfgA } });
      await cf.judgeRows([third.id], `cmq-judge-${tag()}`, 'prompt-3');
      const again = (await get(`/experiments/${id}/compare`).expect(200)).body;
      expect(again.judge_policy_applied).toBe('excluded');
      expect(again.judge.kappa).toBeNull();
    });

    it('only the 2 compared configs count: a third config on an unvalidated judge does not change the a-vs-b policy', async () => {
      const { id, trials } = await seed({ configs: [cfgA, cfgB, cfgC] });
      const judged = (cfg: string) => judgedTrialIds(trials.filter((t) => t.configId === cfg));
      const good = `cmq-judge-${tag()}`;
      const unvalidated = `cmq-judge-${tag()}`;
      await cf.judgeRows(judged(cfgA).concat(judged(cfgB)), good, 'prompt-1');
      await cf.validation({ modelId: good, promptHash: 'prompt-1', kappa: 0.8 });
      await cf.judgeRows(judged(cfgC), unvalidated, 'prompt-9'); // no judge_validation row: excluded if it were counted

      const ab = (await get(`/experiments/${id}/compare?a=${cfgA}&b=${cfgB}`).expect(200)).body;
      expect(ab.judge).toEqual({ model_id: good, prompt_hash: 'prompt-1', kappa: 0.8, policy: 'trusted' });
      expect(ab.judge_policy_applied).toBe('trusted');
      expect(ab.judge_excluded_tasks).toEqual([]);

      for (const [a, b] of [
        [cfgA, cfgC],
        [cfgB, cfgC],
      ]) {
        const withC = (await get(`/experiments/${id}/compare?a=${a}&b=${b}`).expect(200)).body;
        expect(withC.judge_policy_applied).toBe('excluded');
        expect(withC.judge_excluded_tasks).toEqual([JUDGED]);
      }
    });

    it('the latest validation row by computed_at decides, and the policy is re-derived from the stored kappa', async () => {
      const { id, trials } = await seed();
      const m = `cmq-judge-${tag()}`;
      await cf.judgeRows(judgedTrialIds(trials).slice(0, 1), m, 'prompt-1');
      await cf.validation({ modelId: m, promptHash: 'prompt-1', kappa: 0.8, computedAt: new Date('2026-01-01T00:00:00Z') });
      // Newest row has a kappa of 0.2 but a hand-edited policy column that says trusted: the code does not believe it.
      await cf.validation({ modelId: m, promptHash: 'prompt-1', kappa: 0.2, computedAt: new Date('2026-02-01T00:00:00Z'), policy: 'trusted' });
      const { body } = await get(`/experiments/${id}/compare`).expect(200);
      expect(body.judge).toMatchObject({ kappa: 0.2, policy: 'excluded' });
      expect(body.judge_policy_applied).toBe('excluded');
      // An older, better row added later does not win either.
      await cf.validation({ modelId: m, promptHash: 'prompt-1', kappa: 0.9, computedAt: new Date('2025-01-01T00:00:00Z') });
      expect((await get(`/experiments/${id}/compare`).expect(200)).body.judge_policy_applied).toBe('excluded');
    });

    it('validation of a different prompt hash of the same model does not validate this judge', async () => {
      const { id, trials } = await seed();
      const m = `cmq-judge-${tag()}`;
      await cf.judgeRows(judgedTrialIds(trials).slice(0, 1), m, 'prompt-new');
      await cf.validation({ modelId: m, promptHash: 'prompt-old', kappa: 0.9 });
      const { body } = await get(`/experiments/${id}/compare`).expect(200);
      expect(body.judge_policy_applied).toBe('excluded');
      expect(body.judge.kappa).toBeNull();
    });
  });

  describe('what is counted', () => {
    it('compares ALL trials of the 2 configs: errored, cancelled and unfinished are counted, never dropped', async () => {
      const { id, trials } = await seed({ tasks: PLAIN, finish: false });
      const of = (cfg: string, task: string) => trials.find((t) => t.configId === cfg && t.taskId === task)!.id;
      await cf.done(of(cfgA, PLAIN[0]), true);
      await cf.done(of(cfgB, PLAIN[0]), false);
      await cf.done(of(cfgA, PLAIN[1]), true);
      await cf.errored(of(cfgB, PLAIN[1]));
      await cf.cancelled(of(cfgA, PLAIN[2]));
      // B's third trial stays pending.
      const { body } = await get(`/experiments/${id}/compare`).expect(200);
      expect(body.n_excluded).toBe(2);
      expect(body.n_unfinished).toBe(1);
      expect(body.reliability).toBe('partial');
      expect(body.n_scored).toBe(2);
      expect(body.unpaired_tasks.map((u: { task_id: string }) => u.task_id).sort()).toEqual([PLAIN[1], PLAIN[2]]);
    });

    it('a draft with no trials answers 200 with insufficient_data instead of failing', async () => {
      const ex = await prisma.experiment.create({ data: { id: ulid(), name: 'draft', status: 'draft', nTrials: 3, seed: 1, phase: 'pilot', workerManifest: {} } });
      fx.experimentIds.push(ex.id);
      await prisma.experimentConfig.createMany({
        data: [
          { experimentId: ex.id, configId: cfgA, position: 0 },
          { experimentId: ex.id, configId: cfgB, position: 1 },
        ],
      });
      const { body } = await get(`/experiments/${ex.id}/compare`).expect(200);
      expect(body.n_tasks).toBe(0);
      expect(body.aggregate.verdict).toBe('insufficient_data');
      expect(body.n_trials_per_task).toBe(3);
    });

    it('uses the experiment seed and nTrials, 10000 resamples, and passes the axis through', async () => {
      const { id } = await seed({ tasks: PLAIN });
      // D-10: the axis is immutable once the experiment leaves draft, so step back to draft to set it.
      await prisma.experiment.update({ where: { id }, data: { status: 'draft' } });
      await prisma.experiment.update({ where: { id }, data: { axis: 'memory' } });
      const { body } = await get(`/experiments/${id}/compare`).expect(200);
      expect(body.aggregate).toMatchObject({ seed: 7, resamples: 10000 });
      expect(body.n_trials_per_task).toBe(1);
      expect(body.axis).toBe('memory');
      expect(body.ci_method).toBe('percentile');
    });
  });

  describe('persistence and determinism', () => {
    it('persist=1 stores exactly 1 comparison_run whose result equals the response; a repeated plain GET stores nothing', async () => {
      const { id } = await seed({ tasks: PLAIN });
      expect(await prisma.comparisonRun.count({ where: { experimentId: id } })).toBe(0);
      await get(`/experiments/${id}/compare`).expect(200);
      await get(`/experiments/${id}/compare?persist=0`).expect(200);
      await get(`/experiments/${id}/compare`).expect(200);
      expect(await prisma.comparisonRun.count({ where: { experimentId: id } })).toBe(0);

      const res = await get(`/experiments/${id}/compare?persist=1`).expect(200);
      const rows = await prisma.comparisonRun.findMany({ where: { experimentId: id } });
      expect(rows).toHaveLength(1);
      const { comparison_run_id: runId, ...payload } = res.body;
      expect(runId).toBe(rows[0].id);
      expect(rows[0].result).toEqual(payload);
      expect(rows[0]).toMatchObject({
        configAId: cfgA,
        configBId: cfgB,
        statsVersion: STATS_VERSION,
        seed: 7,
        resamples: 10000,
        judgePolicyApplied: 'trusted',
      });

      // Repeated GETs, with and without persist, never touch the stored row; a persist with an equal result reuses it.
      await get(`/experiments/${id}/compare`).expect(200);
      expect(await prisma.comparisonRun.count({ where: { experimentId: id } })).toBe(1);
      const second = await get(`/experiments/${id}/compare?persist=true`).expect(200);
      expect(second.body.comparison_run_id).toBe(runId);
      expect(await prisma.comparisonRun.count({ where: { experimentId: id } })).toBe(1);
      const { comparison_run_id: _ignored, ...again } = second.body;
      expect(again).toEqual(payload);
    });

    it('persist dedupe: an equal newest row is reused, a changed experiment adds a row, and so does a different (a, b)', async () => {
      const { id, trials } = await seed({ configs: [cfgA, cfgB, cfgC], tasks: PLAIN });
      const first = (await get(`/experiments/${id}/compare?a=${cfgA}&b=${cfgB}&persist=1`).expect(200)).body.comparison_run_id;
      expect((await get(`/experiments/${id}/compare?a=${cfgA}&b=${cfgB}&persist=1`).expect(200)).body.comparison_run_id).toBe(first);

      // another pair is another key: a new row, and the first pair still dedupes against its own newest row
      const other = (await get(`/experiments/${id}/compare?a=${cfgA}&b=${cfgC}&persist=1`).expect(200)).body.comparison_run_id;
      expect(other).not.toBe(first);
      expect((await get(`/experiments/${id}/compare?a=${cfgA}&b=${cfgB}&persist=1`).expect(200)).body.comparison_run_id).toBe(first);
      expect(await prisma.comparisonRun.count({ where: { experimentId: id } })).toBe(2);

      // a trial changes: the result differs, so a new row is added; asking again reuses that one
      const t = trials.find((x) => x.configId === cfgB && x.taskId === PLAIN[1])!;
      const flipped = !(await prisma.trial.findUniqueOrThrow({ where: { id: t.id } })).passed;
      await prisma.trial.update({
        where: { id: t.id },
        // the CHECK of 0003_failure_category: a failed done trial carries a category and its evidence
        data: { passed: flipped, failureCategory: flipped ? null : 'wrong_answer', failureEvidence: flipped ? Prisma.DbNull : { rule: 10, category: 'wrong_answer', detail: 'fixture' } },
      });
      const changed = (await get(`/experiments/${id}/compare?a=${cfgA}&b=${cfgB}&persist=1`).expect(200)).body.comparison_run_id;
      expect(changed).not.toBe(first);
      expect((await get(`/experiments/${id}/compare?a=${cfgA}&b=${cfgB}&persist=1`).expect(200)).body.comparison_run_id).toBe(changed);
      expect(await prisma.comparisonRun.count({ where: { experimentId: id } })).toBe(3);
    });

    it('persists the policy that was applied', async () => {
      const { id } = await seed({ finish: true });
      const res = await get(`/experiments/${id}/compare?persist=1`).expect(200);
      expect(res.body.judge_policy_applied).toBe('excluded');
      const row = await prisma.comparisonRun.findFirstOrThrow({ where: { id: res.body.comparison_run_id } });
      expect(row.judgePolicyApplied).toBe('excluded');
      expect((row.result as { judge_excluded_tasks: string[] }).judge_excluded_tasks).toEqual([JUDGED]);
    });

    it('the same request twice returns byte-identical JSON', async () => {
      const { id } = await seed();
      const one = await get(`/experiments/${id}/compare`).expect(200);
      const two = await get(`/experiments/${id}/compare`).expect(200);
      expect(two.text).toBe(one.text);
    });
  });

  describe('pilot', () => {
    it('returns the pilot() payload with no delta or rate keys at any depth, using n_trials as the pilot N and all configs', async () => {
      const { id, trials } = await seed({ configs: [cfgA, cfgB, cfgC], tasks: PLAIN, finish: false });
      await prisma.experiment.update({ where: { id }, data: { nTrials: 2 } });
      const { body } = await get(`/experiments/${id}/pilot`).expect(200);
      expect(body).toMatchObject({ experiment_id: id, n_configs: 3, n_tasks: 3, n_pilot: 2, ready: false });
      expect(typeof body.reason).toBe('string');
      const keys = keysDeep(body);
      for (const forbidden of ['delta', 'rate_a', 'rate_b', 'p_a', 'p_b']) expect(keys.has(forbidden)).toBe(false);
      expect(trials).toHaveLength(9);
    });

    it('counts the judged tasks and projects the width without them, from the same observed variance', async () => {
      // 3 plain + 1 judged task, 2 configs, N = 2: every cell has 1 pass and 1 fail, so s2 = 0.5
      const ex = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: [...PLAIN, JUDGED], nTrials: 2, status: 'running', seed: 7 });
      for (const t of await prisma.trial.findMany({ where: { experimentId: ex.id } })) await cf.done(t.id, t.trialIndex === 0);
      const id = ex.id;
      const { body } = await get(`/experiments/${id}/pilot`).expect(200);
      expect(body).toMatchObject({ ready: true, n_tasks: 4, n_judged_tasks: 1, n_cells_used: 8 });
      const p3 = body.projections.find((p: { n: number }) => p.n === 3);
      expect(p3.half_width_observed).toBeCloseTo(1.96 * Math.sqrt((2 * 0.5) / (3 * 4)), 10);
      expect(p3.half_width_observed_without_judged).toBeCloseTo(1.96 * Math.sqrt((2 * 0.5) / (3 * 3)), 10);
      expect(p3.half_width_observed_without_judged).toBeGreaterThan(p3.half_width_observed);
      for (const forbidden of ['delta', 'rate_a', 'rate_b', 'p_a', 'p_b']) expect(keysDeep(body).has(forbidden)).toBe(false);
    });

    it('works on a draft with no trials: ready false, and answers 200', async () => {
      const ex = await prisma.experiment.create({ data: { id: ulid(), name: 'draft', status: 'draft', nTrials: 3, seed: 1, phase: 'pilot', workerManifest: {} } });
      fx.experimentIds.push(ex.id);
      await prisma.experimentConfig.createMany({
        data: [
          { experimentId: ex.id, configId: cfgA, position: 0 },
          { experimentId: ex.id, configId: cfgB, position: 1 },
        ],
      });
      const { body } = await get(`/experiments/${ex.id}/pilot`).expect(200);
      expect(body.ready).toBe(false);
      expect(body.n_pilot).toBe(3);
      expect(keysDeep(body).has('delta')).toBe(false);
    });
  });
});
