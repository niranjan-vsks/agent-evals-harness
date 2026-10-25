// Fixture payloads for the comparison screen. Shapes follow web/src/api/types.ts; `realP3Payload` is copied from STATE.md
// (P3, "Comparison JSON of that walk"). Everything else is built with makeCompare() and the small factories below.
import type {
  AggregateBlock,
  CategoryBlock,
  ComparePayload,
  Config,
  FailureCounts,
  FailureHistogram,
  ConfigSettings,
  ExperimentDetail,
  MetricComparison,
  PerTaskRow,
} from '../../../api/types';

export const aggregate = (over: Partial<AggregateBlock> = {}): AggregateBlock => ({
  p_a: 0.6,
  p_b: 0.55,
  delta: 0.05,
  ci_low: -0.2,
  ci_high: 0.3,
  verdict: 'noise',
  min_detectable: 0.25,
  resamples: 10000,
  seed: 20260101,
  ...over,
});

export const category = (over: Partial<CategoryBlock> = {}): CategoryBlock => ({ ...aggregate(), n_tasks: 2, ...over });

export const perTask = (over: Partial<PerTaskRow> = {}): PerTaskRow => ({
  task_id: 'task-one',
  category: 'neutral_deterministic',
  n_a: 2,
  n_b: 2,
  rate_a: 1,
  rate_b: 1,
  delta: 0,
  ci_low: 0,
  ci_high: 0,
  verdict: 'noise',
  direction_only: true,
  judge_excluded: false,
  failure_category_a: null,
  failure_category_b: null,
  ...over,
});

/** A zero-filled count map with the given categories set. */
export const counts = (set: Partial<FailureCounts> = {}): FailureCounts => ({
  step_exhaustion: 0,
  timeout: 0,
  hallucinated_tool_args: 0,
  wrong_tool: 0,
  tool_error_unrecovered: 0,
  no_final_answer: 0,
  gave_up_early: 0,
  grader_disagreement: 0,
  memory_ignored: 0,
  wrong_answer: 0,
  ...set,
});

export const failures = (a: Partial<FailureCounts> = {}, b: Partial<FailureCounts> = {}, uncategorized = { a: 0, b: 0 }): FailureHistogram => ({
  a: counts(a),
  b: counts(b),
  uncategorized,
});

export const metric = (
  a: [number | null, number | null, number | null],
  b: [number | null, number | null, number | null],
  deltaCi: [number, number] | null,
): MetricComparison => ({
  a: { mean: a[0], ci_low: a[1], ci_high: a[2] },
  b: { mean: b[0], ci_low: b[1], ci_high: b[2] },
  delta_ci: deltaCi,
});

/** A consistent, complete, trusted payload with a noise aggregate. Override any top level field. */
export function makeCompare(over: Partial<ComparePayload> = {}): ComparePayload {
  return {
    experiment_id: '01EXPERIMENT0000000000000A',
    config_a: { id: '01CONFIGA00000000000000000A', name: 'config alpha' },
    config_b: { id: '01CONFIGB00000000000000000B', name: 'config beta' },
    axis: 'memory off vs seeded',
    n_tasks: 2,
    n_trials_per_task: 2,
    n_scored: 8,
    n_excluded: 0,
    n_unfinished: 0,
    reliability: 'complete',
    rate_limit_affected_trials: 0,
    judge_policy_applied: 'trusted',
    judge_confidence: null,
    judge: { model_id: null, prompt_hash: null, kappa: null, policy: 'trusted' },
    judge_excluded_tasks: [],
    unpaired_tasks: [],
    ci_method: 'percentile',
    aggregate: aggregate(),
    by_category: {
      memory_dependent: category({ n_tasks: 2 }),
      memory_distractor: category({ n_tasks: 3 }),
      neutral: category({ n_tasks: 4 }),
      honesty: category({ n_tasks: 5 }),
    },
    sign_test: { a_wins: 1, b_wins: 1, ties: 0, p_value: 1 },
    mcnemar: null,
    mcnemar_omitted: 'McNemar needs 1 binary outcome per (task, config) pair; this experiment has 2 trials per task',
    per_task: [perTask({ task_id: 'task-one' }), perTask({ task_id: 'task-two', category: 'honesty' })],
    failures: failures(),
    cost: metric([0.0005, 0.0002, 0.001], [0.0002, 0.0001, 0.0003], [-0.00004, 0.0009]),
    latency_ms: metric([25000, 16000, 40000], [16000, 14000, 19000], [800, 25000]),
    tokens: {
      input: metric([31000, 8600, 74000], [9000, 5300, 10900], [-2200, 69000]),
      output: metric([375, 77, 952], [101, 78, 144], [-3.5, 808]),
    },
    stats_version: '1.0.0',
    ...over,
  };
}

/** Aggregate with a chosen interval and verdict; delta defaults to the midpoint-ish value 0.05. */
export const withAggregate = (over: Partial<AggregateBlock>, rest: Partial<ComparePayload> = {}): ComparePayload =>
  makeCompare({ aggregate: aggregate(over), ...rest });

/** The exact payload of the P3 walk in STATE.md: aggregate noise with ci_high exactly 0, 3 insufficient_data categories, 1 null category. */
export const realP3Payload: ComparePayload = (() => {
  const insufficient = (p_a: number, p_b: number, delta: number): CategoryBlock => ({
    p_a,
    p_b,
    delta,
    ci_low: null,
    ci_high: null,
    verdict: 'insufficient_data',
    min_detectable: null,
    reason: '1 paired task(s); an interval needs at least 2 (a single task has no spread); see STATE.md (P3, Assumptions resolved)',
    resamples: 10000,
    seed: 20260101,
    n_tasks: 1,
  });
  const row = (task_id: string, category: PerTaskRow['category'], rate_a: number, rate_b: number, delta: number, verdict: PerTaskRow['verdict']): PerTaskRow => ({
    task_id,
    category,
    n_a: 2,
    n_b: 2,
    rate_a,
    rate_b,
    delta,
    ci_low: delta,
    ci_high: delta,
    verdict,
    direction_only: true,
    judge_excluded: false,
    // The failures block did not exist in P3: these two fields are synthetic, consistent with the 0 of 2 of mem-01 under memory off.
    failure_category_a: rate_a < 1 ? 'wrong_answer' : null,
    failure_category_b: rate_b < 1 ? 'wrong_answer' : null,
  });
  return {
    experiment_id: '01M5Q85G672WKH4QMQ4XXA53HN',
    config_a: { id: '01M5Q85G0G7A3SQY0RTCB9XMDA', name: 'hermes memory off' },
    config_b: { id: '01M5Q85G4GVMM7X56XAWX7G2QM', name: 'hermes memory seeded' },
    axis: 'hermes memory off vs seeded',
    n_tasks: 3,
    n_trials_per_task: 2,
    n_scored: 12,
    n_excluded: 0,
    n_unfinished: 0,
    reliability: 'complete',
    rate_limit_affected_trials: 0,
    judge_policy_applied: 'trusted',
    judge_confidence: null,
    judge: { model_id: null, prompt_hash: null, kappa: null, policy: 'trusted' },
    judge_excluded_tasks: [],
    unpaired_tasks: [],
    ci_method: 'percentile',
    aggregate: {
      p_a: 0.6666666666666666,
      p_b: 1,
      delta: -0.3333333333333333,
      ci_low: -1,
      ci_high: 0,
      verdict: 'noise',
      min_detectable: 0.5,
      resamples: 10000,
      seed: 20260101,
    },
    by_category: {
      memory_dependent: insufficient(0, 1, -1),
      memory_distractor: null,
      neutral: insufficient(1, 1, 0),
      honesty: insufficient(1, 1, 0),
    },
    sign_test: { a_wins: 0, b_wins: 1, ties: 2, p_value: 1 },
    mcnemar: null,
    mcnemar_omitted: 'McNemar needs 1 binary outcome per (task, config) pair; this experiment has 2 trials per task',
    per_task: [
      row('det-06-ini', 'neutral_deterministic', 1, 1, 0, 'noise'),
      row('hon-01-missing-key', 'honesty', 1, 1, 0, 'noise'),
      row('mem-01-staging-db', 'memory_dependent', 0, 1, -1, 'B_better'),
    ],
    cost: metric([0.000597, 0.000162, 0.0014260000000000002], [0.00017166666666666667, 0.00010899999999999999, 0.00020299999999999997], [-0.000040999999999999994, 0.0013170000000000002]),
    latency_ms: metric([25230.833333333332, 16531.5, 39538], [16057.5, 13883, 18802], [821, 25655]),
    tokens: {
      input: metric([31278.833333333332, 8599, 74445.5], [9024.333333333334, 5327, 10879], [-2268, 69118.5]),
      output: metric([375.1666666666667, 77, 952.5], [101, 78, 144.5], [-3.5, 808]),
    },
    failures: failures({ wrong_answer: 2 }),
    stats_version: '1.0.0',
    comparison_run_id: '01M5Q8A3MGSM0TWT0RH6WJQPEJ',
  };
})();

// ---------------------------------------------------------------- experiments and configs

export function makeExperiment(over: Partial<ExperimentDetail> = {}, configs?: Array<{ id: string; name: string }>): ExperimentDetail {
  const list = configs ?? [
    { id: '01CONFIGA00000000000000000A', name: 'config alpha' },
    { id: '01CONFIGB00000000000000000B', name: 'config beta' },
  ];
  return {
    id: '01EXPERIMENT0000000000000A',
    name: 'fixture experiment',
    status: 'completed',
    n_trials: 2,
    seed: 20260101,
    phase: 'full',
    axis: 'memory off vs seeded',
    hypothesis: 'fixture hypothesis',
    worker_manifest: null,
    created_at: '2026-10-24T22:18:30.192Z',
    started_at: '2026-10-24T22:18:30.308Z',
    finished_at: '2026-10-24T22:21:11.239Z',
    pause_reason: null,
    paused: false,
    progress: { pending: 0, running: 0, done: 8, errored: 0, cancelled: 0, total: 8 },
    configs: list.map((c, i) => ({ id: c.id, name: c.name, position: i, harness_id: 'hermes', model_slug: 'openai/gpt-oss-20b' })),
    tasks: [
      { task_id: 'task-one', task_version_hash: 'h1', category: 'neutral_deterministic' },
      { task_id: 'task-two', task_version_hash: 'h2', category: 'honesty' },
    ],
    ...over,
  };
}

export const baseSettings = (): ConfigSettings => ({
  tools: ['files', 'shell'],
  memory: { mode: 'off', fixture: null, fixture_hash: null },
  skills: { enabled: false, preload: [] },
  temperature: 0,
  max_steps: 15,
  max_output_tokens: 2048,
  timeout_seconds: 300,
  harness_options: { providers_ignored: ['Darkbloom', 'Groq'] },
});

export function makeConfig(over: Partial<Config> = {}, settings: Partial<ConfigSettings> = {}): Config {
  return {
    id: '01CONFIGA00000000000000000A',
    name: 'config alpha',
    harness_id: 'hermes',
    harness_version: 'f4ac0bea1e',
    model_id: 'model-b',
    model_slug: 'openai/gpt-oss-20b',
    settings: { ...baseSettings(), ...settings },
    config_hash: '638fcbb999c8fb535e7aa8155bc13fc148cc0bed241d0e91240c11459890ae66',
    created_at: '2026-10-24T15:23:45.046Z',
    ...over,
  };
}

export const memoryOff = (): Config => makeConfig({ id: '01CONFIGA00000000000000000A', name: 'config alpha' });

export const memorySeeded = (): Config =>
  makeConfig(
    { id: '01CONFIGB00000000000000000B', name: 'config beta', config_hash: '1b359ab5b8b402d225622f3bc0861813bd15b77126232645038d0aaf5b2af88e' },
    { memory: { mode: 'seeded', fixture: 'team-memory-v1', fixture_hash: 'e0451488979f8ce982179575ab1ed530d6531ccaae5eed4a76101eabf2a2c168' } },
  );
