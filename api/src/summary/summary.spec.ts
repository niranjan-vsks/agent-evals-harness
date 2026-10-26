import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CompareFixtures, EXACT_GRADER } from '../../test/compare-fixtures';
import { createExperimentsApp } from '../../test/experiments-app';
import { Fixtures } from '../../test/helpers';
import { FAILURE_CATEGORIES } from '../failures/rules';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { compare, CompareTrial } from '../stats/compare';
import { configRow, failureCounts, LATEST_COMPARISONS, macroMean, newestPerPair, passOutcome, SummaryPayload, SummaryTrial } from './summary.service';

/** A done trial of the pure fixtures below. */
const done = (configId: string, taskId: string, trialIndex: number, passed: boolean | null, costUsd = 0.01, latencyMs = 1000): CompareTrial => ({
  configId,
  taskId,
  trialIndex,
  status: 'done',
  passed,
  costUsd,
  latencyMs,
  inputTokens: 3000 + trialIndex,
  outputTokens: 40,
  rateLimitEvents: 0,
});

const asSummary = (ts: CompareTrial[]): SummaryTrial[] =>
  ts.map((t) => ({ configId: t.configId, taskId: t.taskId, passed: t.passed, costUsd: t.costUsd, latencyMs: t.latencyMs, inputTokens: t.inputTokens, outputTokens: t.outputTokens }));

/**
 * 3 tasks with unequal trial counts, so the macro average and the raw trial mean differ:
 * A: t1 1 of 3, t2 1 of 1, t3 0 of 2  -> macro (1/3 + 1 + 0) / 3 = 0.444, raw 2 of 6 = 0.333.
 * B: t1 3 of 3, t2 0 of 1, t3 1 of 2  -> macro (1 + 0 + 0.5) / 3 = 0.5,   raw 4 of 6 = 0.667.
 */
const FIXTURE: CompareTrial[] = [
  done('A', 't1', 0, true, 0.01, 900),
  done('A', 't1', 1, false, 0.02, 1100),
  done('A', 't1', 2, false, 0.03, 1300),
  done('A', 't2', 0, true, 0.1, 5000),
  done('A', 't3', 0, false, 0.04, 2000),
  done('A', 't3', 1, false, 0.06, 2200),
  done('B', 't1', 0, true),
  done('B', 't1', 1, true),
  done('B', 't1', 2, true),
  done('B', 't2', 0, false, 0.5, 9000),
  done('B', 't3', 0, true, 0.02, 1500),
  done('B', 't3', 1, false, 0.04, 1700),
];

const comparePayload = () =>
  compare(
    {
      experimentId: 'E',
      axis: 'memory',
      configA: { id: 'A', name: 'a' },
      configB: { id: 'B', name: 'b' },
      nTrialsPerTask: 3,
      tasks: ['t1', 't2', 't3'].map((id) => ({ id, category: 'neutral_deterministic' as const, judged: false })),
      trials: FIXTURE,
    },
    { seed: 7, resamples: 200, perTaskResamples: 50, judge: { policy: 'trusted', modelId: null, promptHash: null, kappa: null } },
  );

const cfg = (id: string, settings: unknown = { memory: { mode: 'seeded' } }) => ({ id, name: `config ${id}`, harnessId: 'hermes', modelId: 'model-b', settings });

describe('summary aggregation (pure)', () => {
  it('pass_rate equals the p_a and p_b of compare.ts on the same trials (the macro average of DESIGN 9.1)', () => {
    const p = comparePayload();
    const rowA = configRow(cfg('A'), asSummary(FIXTURE.filter((t) => t.configId === 'A')));
    const rowB = configRow(cfg('B'), asSummary(FIXTURE.filter((t) => t.configId === 'B')));
    expect(rowA.pass_rate).toBe(p.aggregate.p_a);
    expect(rowB.pass_rate).toBe(p.aggregate.p_b);
    // The fixture is built so that a raw trial mean would differ: this is what keeps the test from passing by accident.
    expect(rowA.pass_rate).toBeCloseTo(4 / 9, 12);
    expect(rowA.pass_rate).not.toBeCloseTo(2 / 6, 3);
    expect(rowB.pass_rate).toBeCloseTo(0.5, 12);
  });

  it('cost, latency and token means equal the means compare.ts reports for the same trials', () => {
    const p = comparePayload();
    const rowA = configRow(cfg('A'), asSummary(FIXTURE.filter((t) => t.configId === 'A')));
    const rowB = configRow(cfg('B'), asSummary(FIXTURE.filter((t) => t.configId === 'B')));
    expect(rowA.mean_cost_usd).toBeCloseTo(p.cost.a.mean!, 12);
    expect(rowB.mean_cost_usd).toBeCloseTo(p.cost.b.mean!, 12);
    expect(rowA.mean_latency_ms).toBeCloseTo(p.latency_ms.a.mean!, 12);
    expect(rowA.mean_input_tokens).toBeCloseTo(p.tokens.input.a.mean!, 12);
    expect(rowB.mean_output_tokens).toBeCloseTo(p.tokens.output.b.mean!, 12);
  });

  it('leaves an ungraded done trial out of the pass rate but counts it as done and in the cost', () => {
    const ts = asSummary([done('A', 't1', 0, true, 0.01), done('A', 't1', 1, null, 0.03), done('A', 't2', 0, false, 0.02)]);
    const row = configRow(cfg('A'), ts);
    expect(row.trials_done).toBe(3);
    expect(row.pass_rate).toBe(0.5);
    expect(row.mean_cost_usd).toBeCloseTo((0.02 + 0.02) / 2, 12);
    expect(macroMean(ts, passOutcome)).toBe(0.5);
  });

  it('gives null means and memory_mode null for a config with no done trial and no memory setting', () => {
    const row = configRow(cfg('C', {}), []);
    expect(row).toMatchObject({ trials_done: 0, pass_rate: null, mean_cost_usd: null, mean_latency_ms: null, memory_mode: null });
    expect(configRow(cfg('D'), []).memory_mode).toBe('seeded');
  });

  it('lists every failure category in rule order and adds uncategorized only when some failed trial has none', () => {
    const f = failureCounts([
      { failureCategory: 'wrong_answer', count: 3 },
      { failureCategory: 'abstained', count: 1 },
    ]);
    expect(Object.keys(f)).toEqual([...FAILURE_CATEGORIES]);
    expect(f).toMatchObject({ wrong_answer: 3, abstained: 1, timeout: 0 });
    const g = failureCounts([{ failureCategory: null, count: 2 }]);
    expect(g.uncategorized).toBe(2);
    expect(Object.keys(g)).toHaveLength(FAILURE_CATEGORIES.length + 1);
  });

  it('keeps the newest run of each (experiment, A, B) pair, newest first, up to the limit', () => {
    const run = (id: string, experimentId: string, a = 'A', b = 'B') => ({ id, experimentId, configAId: a, configBId: b });
    const runs = [run('r6', 'e1'), run('r5', 'e1'), run('r4', 'e2'), run('r3', 'e1', 'B', 'A'), run('r2', 'e3'), run('r1', 'e4')];
    expect(newestPerPair(runs, 10).map((r) => r.id)).toEqual(['r6', 'r4', 'r3', 'r2', 'r1']);
    expect(newestPerPair(runs, 2).map((r) => r.id)).toEqual(['r6', 'r4']);
  });
});

/** GET /summary against the real database. The database is shared by the specs, so totals are checked as differences. */
describe('GET /summary (P8)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: Fixtures;
  let cf: CompareFixtures;
  let cfgA: string;
  let cfgB: string;
  const TASKS = ['smy-01-a', 'smy-02-a', 'smy-03-a'];

  beforeAll(async () => {
    ({ app, prisma } = await createExperimentsApp());
    fx = new Fixtures(prisma);
    cf = new CompareFixtures(prisma, fx);
  });

  afterAll(async () => {
    await cf.cleanup();
    await app.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);
  const summary = async (): Promise<SummaryPayload> => (await get('/summary').expect(200)).body;

  it('reports the seeded rows: totals, the config rows equal to Compare, the newest persisted verdict, failures and progress', async () => {
    const before = await summary();

    const base = await fx.base();
    cfgA = await fx.config(base, 'summary A', { memory: { mode: 'off', fixture: null, fixture_hash: null } });
    cfgB = await fx.config(base, 'summary B', { memory: { mode: 'seeded', fixture: 'f', fixture_hash: 'h' } });
    for (const id of TASKS) await cf.task(id, 'neutral_deterministic', [EXACT_GRADER]);
    const ex = await fx.experiment({ configIds: [cfgA, cfgB], taskIds: TASKS, nTrials: 2, status: 'running', seed: 7 });
    const trials = await prisma.trial.findMany({ where: { experimentId: ex.id }, orderBy: [{ taskId: 'asc' }, { trialIndex: 'asc' }] });
    const of = (cfgId: string, task: string, i: number) => trials.find((t) => t.configId === cfgId && t.taskId === task && t.trialIndex === i)!.id;
    // A: task 1 both pass, task 2 1 of 2, task 3 1 of 1 (its second trial errored): macro (1 + 0.5 + 1) / 3, raw 4 of 5.
    await cf.done(of(cfgA, TASKS[0], 0), true, { costUsd: 0.25 });
    await cf.done(of(cfgA, TASKS[0], 1), true, { costUsd: 0.25 });
    await cf.done(of(cfgA, TASKS[1], 0), true, { costUsd: 0.25 });
    await cf.done(of(cfgA, TASKS[1], 1), false, { costUsd: 0.25, failureCategory: 'abstained' });
    await cf.done(of(cfgA, TASKS[2], 0), true, { costUsd: 0.25 });
    await cf.errored(of(cfgA, TASKS[2], 1));
    // B: fails everything but task 1.
    for (const task of TASKS) for (const i of [0, 1]) await cf.done(of(cfgB, task, i), task === TASKS[0], { costUsd: 0.5 });

    const first = (await get(`/experiments/${ex.id}/compare?a=${cfgA}&b=${cfgB}&persist=1`).expect(200)).body;
    // A regrade changes B's numbers, so the second persisted run of the same pair is a new row and supersedes the first.
    await prisma.comparisonRun.update({ where: { id: first.comparison_run_id }, data: { computedAt: new Date(Date.now() - 60_000) } });
    await prisma.trial.update({ where: { id: of(cfgB, TASKS[1], 0) }, data: { passed: true, failureCategory: null, failureEvidence: Prisma.DbNull } });
    expect(first.comparison_run_id).toBeDefined();
    const latest = (await get(`/experiments/${ex.id}/compare?a=${cfgA}&b=${cfgB}&persist=1`).expect(200)).body;

    const after = await summary();

    expect(after.totals.experiments - before.totals.experiments).toBe(1);
    expect(after.totals.configs - before.totals.configs).toBe(2);
    expect(after.totals.tasks_current - before.totals.tasks_current).toBe(3);
    expect(after.totals.trials_done - before.totals.trials_done).toBe(11);
    expect(after.totals.trials_errored - before.totals.trials_errored).toBe(1);
    expect(after.totals.spend_usd - before.totals.spend_usd).toBeCloseTo(5 * 0.25 + 6 * 0.5, 6);
    expect(after.totals.models - before.totals.models).toBe(1);
    expect(after.totals.harnesses - before.totals.harnesses).toBe(1);

    const rowA = after.configs.find((c) => c.config_id === cfgA)!;
    const rowB = after.configs.find((c) => c.config_id === cfgB)!;
    expect(rowA).toMatchObject({ name: 'summary A', harness_id: base.harnessId, model_id: base.modelId, memory_mode: 'off', trials_done: 5 });
    expect(rowB).toMatchObject({ memory_mode: 'seeded', trials_done: 6 });
    // These configs ran in this experiment only, so the dashboard's pass rate is the Compare page's, number for number.
    expect(rowA.pass_rate).toBe(latest.aggregate.p_a);
    expect(rowB.pass_rate).toBe(latest.aggregate.p_b);
    expect(rowA.pass_rate).toBeCloseTo(2.5 / 3, 12);
    expect(rowA.mean_cost_usd).toBeCloseTo(0.25, 12);

    expect(latest.comparison_run_id).not.toBe(first.comparison_run_id);
    const card = after.latest_comparisons[0];
    expect(after.latest_comparisons.length).toBeLessThanOrEqual(LATEST_COMPARISONS);
    expect(after.latest_comparisons.filter((c) => c.experiment_id === ex.id)).toHaveLength(1);
    expect(card).toMatchObject({
      comparison_run_id: latest.comparison_run_id,
      experiment_id: ex.id,
      experiment_name: `sch-${ex.id}`,
      config_a_id: cfgA,
      config_a_name: 'summary A',
      config_b_id: cfgB,
      config_b_name: 'summary B',
      verdict: latest.aggregate.verdict,
      delta: latest.aggregate.delta,
      ci_low: latest.aggregate.ci_low,
      ci_high: latest.aggregate.ci_high,
      reliability: 'partial',
      judge_policy_applied: 'trusted',
      stats_version: latest.stats_version,
    });

    expect(after.failures.abstained! - before.failures.abstained!).toBe(1);
    expect(after.failures.wrong_answer! - before.failures.wrong_answer!).toBe(3);

    const recent = after.recent_experiments.find((e) => e.id === ex.id)!;
    expect(recent).toMatchObject({ status: 'running', n_trials: 2 });
    expect(recent.progress).toEqual({ pending: 0, running: 0, done: 11, errored: 1, cancelled: 0, total: 12 });
  });

  it('is read-only: GET /summary twice leaves the comparison_run count unchanged', async () => {
    const n = await prisma.comparisonRun.count();
    await summary();
    await summary();
    expect(await prisma.comparisonRun.count()).toBe(n);
  });
});
