import { FAILURE_CATEGORIES, FailureCategory } from '../failures/rules';
import { mulberry32, percentileBootstrap, quantileSorted } from './bootstrap';
import { mcnemar, McNemarResult } from './mcnemar';
import { signTest, SignTestResult } from './sign-test';
import { STATS_VERSION } from './version';

/**
 * A vs B (DESIGN 9.2 to 9.6), pure. Only `done` trials are scored; errored and cancelled ones are counted and
 * the comparison says it is partial; unfinished ones are counted too. The CI is the percentile bootstrap over
 * tasks (paired by task); the verdict is the noise rule of 9.4. No I/O: the judge policy arrives in `opts`.
 */

export type TrialStatus = 'pending' | 'running' | 'done' | 'errored' | 'cancelled';
export type TaskCategory = 'memory_dependent' | 'memory_distractor' | 'neutral_deterministic' | 'neutral_judged' | 'honesty';
export type JudgePolicy = 'trusted' | 'flagged' | 'excluded';
export type Verdict = 'A_better' | 'B_better' | 'noise';

export interface CompareTrial {
  configId: string;
  taskId: string;
  trialIndex: number;
  status: TrialStatus;
  passed: boolean | null;
  costUsd: number | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  rateLimitEvents: number;
  /** P6: set on a done trial that failed (api/src/failures). Absent or null counts as uncategorized. */
  failureCategory?: FailureCategory | null;
}

export interface CompareTask {
  id: string;
  category: TaskCategory;
  /** Has an llm_judge grader. */
  judged: boolean;
}

export interface CompareInput {
  experimentId: string;
  axis: string | null;
  configA: { id: string; name: string };
  configB: { id: string; name: string };
  nTrialsPerTask: number;
  tasks: CompareTask[];
  /** Trials of A and B only, any status. */
  trials: CompareTrial[];
}

export interface CompareOptions {
  seed: number;
  /** Aggregate, per-category and cost resamples. Default 10000. */
  resamples?: number;
  /** Per-task resamples. Default 2000. */
  perTaskResamples?: number;
  judge: { policy: JudgePolicy; modelId: string | null; promptHash: string | null; kappa: number | null };
}

export const DEFAULT_RESAMPLES = 10000;
export const DEFAULT_PER_TASK_RESAMPLES = 2000;

/**
 * An aggregate or category block needs at least 2 paired tasks to carry an interval. This is a deliberate guard of this
 * implementation, not a statistical theorem (see STATE.md, P3, Assumptions resolved): with 1 paired task the bootstrap
 * interval is a single point [d, d] and the noise rule would call any non-zero delta a win with min_detectable 0. With 2
 * the interval is the min..max of the 2 task deltas: coarse but real, and it lets the pre-registered per-category
 * hypotheses for the 2-task categories (memory_distractor, honesty) be evaluated. Below the minimum the block keeps p_a,
 * p_b and delta and reports verdict 'insufficient_data' with a reason. The sign test and McNemar are exact tests with no
 * resampling and are unaffected.
 */
export const MIN_PAIRED_TASKS = 2;
/** Per task, each side needs at least 2 scored trials before its trials are resampled. */
export const MIN_TRIALS_PER_SIDE = 2;

export interface AggregateBlock {
  p_a: number | null;
  p_b: number | null;
  delta: number | null;
  ci_low: number | null;
  ci_high: number | null;
  verdict: Verdict | 'insufficient_data';
  min_detectable: number | null;
  /** Present only when the verdict is insufficient_data because only 1 task was paired. */
  reason?: string;
  resamples: number;
  seed: number;
}

export interface CategoryBlock extends AggregateBlock {
  n_tasks: number;
}

export interface PerTaskRow {
  task_id: string;
  category: TaskCategory;
  n_a: number;
  n_b: number;
  rate_a: number | null;
  rate_b: number | null;
  delta: number | null;
  ci_low: number | null;
  ci_high: number | null;
  /** insufficient_data when either side has fewer than 2 scored trials (the CI is then null). */
  verdict: Verdict | 'insufficient_data';
  /** The CI resamples N trials per side; at small N it shows direction only (DESIGN 9.5). */
  direction_only: true;
  /** The task is judged and the judge policy is `excluded`: the numbers are shown but kept out of every headline figure. */
  judge_excluded: boolean;
  /** The most frequent failure category among A's failed trials of this task (ties go to the earlier rule), null when A has none. */
  failure_category_a: FailureCategory | null;
  failure_category_b: FailureCategory | null;
}

/** Failed trials per category, every category present (0 when none) in the order of the rules. */
export type FailureCounts = Record<FailureCategory, number>;

export interface FailureHistogram {
  a: FailureCounts;
  b: FailureCounts;
  /** Failed done trials that carry no category yet (a database not yet backfilled): they are in neither a nor b. */
  uncategorized: { a: number; b: number };
}

export interface MetricBlock {
  mean: number | null;
  ci_low: number | null;
  ci_high: number | null;
}

export interface MetricComparison {
  a: MetricBlock;
  b: MetricBlock;
  /** 95 percent interval of the paired difference A - B over tasks both configs have a value for. */
  delta_ci: [number, number] | null;
}

export interface ComparePayload {
  experiment_id: string;
  config_a: { id: string; name: string };
  config_b: { id: string; name: string };
  axis: string | null;
  n_tasks: number;
  n_trials_per_task: number;
  n_scored: number;
  n_excluded: number;
  n_unfinished: number;
  reliability: 'complete' | 'partial';
  rate_limit_affected_trials: number;
  judge_policy_applied: JudgePolicy;
  judge_confidence: 'low' | null;
  judge: { model_id: string | null; prompt_hash: string | null; kappa: number | null; policy: JudgePolicy };
  judge_excluded_tasks: string[];
  unpaired_tasks: Array<{ task_id: string; reason: string }>;
  ci_method: 'percentile';
  aggregate: AggregateBlock;
  by_category: {
    memory_dependent: CategoryBlock | null;
    memory_distractor: CategoryBlock | null;
    neutral: CategoryBlock | null;
    honesty: CategoryBlock | null;
  };
  sign_test: SignTestResult;
  mcnemar: McNemarResult | null;
  mcnemar_omitted: string | null;
  per_task: PerTaskRow[];
  /**
   * P6. Counts every failed done trial (status done, passed false) of configs A and B, whatever the task: unpaired tasks and
   * errored-out tasks included, so it can exceed what n_scored covers. Tasks withheld by the judge policy are in
   * `failures_judge_excluded` instead.
   */
  failures: FailureHistogram;
  /** The same count for the failed trials of the tasks withheld by the judge policy `excluded`; null under any other policy. */
  failures_judge_excluded: FailureHistogram | null;
  cost: MetricComparison;
  latency_ms: MetricComparison;
  tokens: { input: MetricComparison; output: MetricComparison };
  stats_version: string;
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

const emptyCounts = (): FailureCounts => Object.fromEntries(FAILURE_CATEGORIES.map((c) => [c, 0])) as FailureCounts;
const emptyHistogram = (): FailureHistogram => ({ a: emptyCounts(), b: emptyCounts(), uncategorized: { a: 0, b: 0 } });
const isFailed = (t: CompareTrial) => t.status === 'done' && t.passed === false;

/** The commonest category among the failed trials; a tie goes to the category that comes first in FAILURE_CATEGORIES (the card's rule order). */
function modeCategory(ts: readonly CompareTrial[]): FailureCategory | null {
  const counts = emptyCounts();
  for (const t of ts) if (isFailed(t) && t.failureCategory) counts[t.failureCategory]++;
  let best: FailureCategory | null = null;
  for (const c of FAILURE_CATEGORIES) if (counts[c] > 0 && (best === null || counts[c] > counts[best])) best = c;
  return best;
}

/**
 * The noise rule (DESIGN 9.4): noise iff CI_low <= 0 <= CI_high, so a CI that touches 0 is noise. The
 * endpoints are rounded to 12 decimals first so that float dust (1e-17 from a mean of thirds) cannot
 * turn an interval that is exactly [0, x] into a win.
 */
export function noiseRule(delta: number, ciLow: number, ciHigh: number): Verdict {
  const clean = (x: number) => Math.round(x * 1e12) / 1e12;
  if (clean(ciLow) <= 0 && clean(ciHigh) >= 0) return 'noise';
  return delta > 0 ? 'A_better' : 'B_better';
}

/** DESIGN 9.3 on a list of per-task [rateA, rateB] pairs. */
function pairedBlock(pairs: ReadonlyArray<readonly [number, number]>, resamples: number, seed: number): AggregateBlock {
  if (pairs.length === 0) {
    return { p_a: null, p_b: null, delta: null, ci_low: null, ci_high: null, verdict: 'insufficient_data', min_detectable: null, resamples, seed };
  }
  if (pairs.length < MIN_PAIRED_TASKS) {
    const pA = mean(pairs.map(([a]) => a));
    const pB = mean(pairs.map(([, b]) => b));
    return {
      p_a: pA,
      p_b: pB,
      delta: mean(pairs.map(([a, b]) => a - b)),
      ci_low: null,
      ci_high: null,
      verdict: 'insufficient_data',
      min_detectable: null,
      reason: `${pairs.length} paired task(s); an interval needs at least ${MIN_PAIRED_TASKS} (a single task has no spread); see STATE.md (P3, Assumptions resolved)`,
      resamples,
      seed,
    };
  }
  const boot = percentileBootstrap(pairs, (s) => mean(s.map(([a, b]) => a - b)), resamples, seed);
  return {
    p_a: mean(pairs.map(([a]) => a)),
    p_b: mean(pairs.map(([, b]) => b)),
    delta: boot.observed,
    ci_low: boot.ciLow,
    ci_high: boot.ciHigh,
    verdict: noiseRule(boot.observed, boot.ciLow, boot.ciHigh),
    min_detectable: (boot.ciHigh - boot.ciLow) / 2,
    resamples,
    seed,
  };
}

/**
 * Within-task CI of mean(a) - mean(b): A's outcomes and B's outcomes are resampled separately (DESIGN 9.5).
 * percentileBootstrap draws 1 sample from 1 list, so it cannot do this; this reuses its PRNG and quantile
 * (1 stream, A's n draws then B's n draws per resample) rather than a second resampler of its own.
 */
function twoSampleDeltaCi(a: readonly number[], b: readonly number[], resamples: number, seed: number): [number, number] {
  const rng = mulberry32(seed);
  const deltas: number[] = new Array<number>(resamples);
  for (let r = 0; r < resamples; r++) {
    let sa = 0;
    for (let i = 0; i < a.length; i++) sa += a[Math.floor(rng() * a.length)];
    let sb = 0;
    for (let i = 0; i < b.length; i++) sb += b[Math.floor(rng() * b.length)];
    deltas[r] = sa / a.length - sb / b.length;
  }
  deltas.sort((x, y) => x - y);
  return [quantileSorted(deltas, 0.025), quantileSorted(deltas, 0.975)];
}

const NO_METRIC: MetricBlock = { mean: null, ci_low: null, ci_high: null };

function metricBlock(perTaskMeans: number[], resamples: number, seed: number): MetricBlock {
  if (perTaskMeans.length === 0) return { ...NO_METRIC };
  const boot = percentileBootstrap(perTaskMeans, mean, resamples, seed);
  return { mean: boot.observed, ci_low: boot.ciLow, ci_high: boot.ciHigh };
}

export function compare(input: CompareInput, opts: CompareOptions): ComparePayload {
  const resamples = opts.resamples ?? DEFAULT_RESAMPLES;
  const perTaskResamples = opts.perTaskResamples ?? DEFAULT_PER_TASK_RESAMPLES;
  const { seed } = opts;
  const policy = opts.judge.policy;
  const idA = input.configA.id;
  const idB = input.configB.id;

  // Ordered by trial index so that the resampled lists below do not depend on the order the caller loaded rows in.
  const ours = input.trials.filter((t) => t.configId === idA || t.configId === idB).sort((x, y) => x.trialIndex - y.trialIndex);
  // A done trial with no verdict (passed = null) cannot be a pass or a fail, so it is as unusable as an errored one.
  const nExcluded = ours.filter((t) => t.status === 'errored' || t.status === 'cancelled' || (t.status === 'done' && t.passed === null)).length;
  const nUnfinished = ours.filter((t) => t.status === 'pending' || t.status === 'running').length;

  // A trial is scored when it is done and graded; an ungraded done trial is left out of the rates (its cost and latency still count).
  const byTask = new Map<string, { a: CompareTrial[]; b: CompareTrial[] }>();
  for (const t of ours) {
    if (t.status !== 'done') continue;
    const slot = byTask.get(t.taskId) ?? { a: [], b: [] };
    (t.configId === idA ? slot.a : slot.b).push(t);
    byTask.set(t.taskId, slot);
  }
  const scored = (ts: CompareTrial[]) => ts.filter((t) => t.passed !== null);
  const outcomes = (ts: CompareTrial[]) => scored(ts).map((t) => (t.passed ? 1 : 0));

  // Sorted by id: the per-task seed and every list below must not depend on the order the caller loaded tasks in.
  const tasks = [...input.tasks].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const excludeJudged = policy === 'excluded';
  // neutral_judged is judged by definition: if the caller's flag misses it, the category still keeps it out of the headline.
  const isJudged = (t: CompareTask) => t.judged || t.category === 'neutral_judged';
  const judgeExcluded = tasks.filter((t) => isJudged(t) && excludeJudged).map((t) => t.id);

  const unpaired: Array<{ task_id: string; reason: string }> = [];
  const paired: Array<{ task: CompareTask; index: number; a: number[]; b: number[] }> = [];
  tasks.forEach((task, index) => {
    const slot = byTask.get(task.id);
    const a = outcomes(slot?.a ?? []);
    const b = outcomes(slot?.b ?? []);
    if (a.length > 0 && b.length > 0) paired.push({ task, index, a, b });
    else if (a.length === 0 && b.length === 0) unpaired.push({ task_id: task.id, reason: 'no scored trial for either config' });
    else unpaired.push({ task_id: task.id, reason: `no scored trial for config ${a.length === 0 ? 'A' : 'B'}` });
  });

  const unpairedInHeadline = unpaired.filter((u) => !judgeExcluded.includes(u.task_id)).length;
  const withheld = (p: { task: CompareTask }) => isJudged(p.task) && excludeJudged;
  const headline = paired.filter((p) => !withheld(p));
  const rates = headline.map((p) => ({ p, ra: mean(p.a), rb: mean(p.b) }));
  const pairsOf = (rs: typeof rates) => rs.map((r) => [r.ra, r.rb] as const);

  const group = (c: TaskCategory) => (c === 'neutral_deterministic' || c === 'neutral_judged' ? 'neutral' : c);
  const category = (name: 'memory_dependent' | 'memory_distractor' | 'neutral' | 'honesty'): CategoryBlock | null => {
    const rs = rates.filter((r) => group(r.p.task.category) === name);
    return rs.length === 0 ? null : { ...pairedBlock(pairsOf(rs), resamples, seed), n_tasks: rs.length };
  };

  // Judge-excluded rows keep their numbers (DESIGN 8.3: shown apart, with a badge); they are not in `headline`.
  const perTask: PerTaskRow[] = paired.map((p) => {
    const ra = mean(p.a);
    const rb = mean(p.b);
    const base = { task_id: p.task.id, category: p.task.category, n_a: p.a.length, n_b: p.b.length, rate_a: ra, rate_b: rb, delta: ra - rb };
    const slot = byTask.get(p.task.id)!;
    const tail = {
      direction_only: true as const,
      judge_excluded: withheld(p),
      failure_category_a: modeCategory(slot.a),
      failure_category_b: modeCategory(slot.b),
    };
    if (p.a.length < MIN_TRIALS_PER_SIDE || p.b.length < MIN_TRIALS_PER_SIDE) {
      return { ...base, ci_low: null, ci_high: null, verdict: 'insufficient_data', ...tail };
    }
    const [lo, hi] = twoSampleDeltaCi(p.a, p.b, perTaskResamples, seed + p.index + 1);
    return { ...base, ci_low: lo, ci_high: hi, verdict: noiseRule(ra - rb, lo, hi), ...tail };
  });

  // Every failed trial is a cause worth showing, paired or not; the judge-withheld tasks go in their own histogram so the
  // largest real category (judge_criteria_unmet) does not vanish under the policy that hides those tasks from the headline.
  const failures = emptyHistogram();
  const failuresJudgeExcluded = excludeJudged ? emptyHistogram() : null;
  for (const t of ours) {
    if (!isFailed(t)) continue;
    const hist = failuresJudgeExcluded && judgeExcluded.includes(t.taskId) ? failuresJudgeExcluded : failures;
    const side = t.configId === idA ? 'a' : 'b';
    if (t.failureCategory) hist[side][t.failureCategory]++;
    else hist.uncategorized[side]++;
  }

  const nScored = headline.reduce((n, p) => n + p.a.length + p.b.length, 0);
  // Only trials that entered the headline: errored attempts and judge-withheld tasks say nothing about the reported numbers.
  const headlineTasks = new Set(headline.map((p) => p.task.id));
  const rateLimitAffected = ours.filter(
    (t) => t.status === 'done' && t.passed !== null && headlineTasks.has(t.taskId) && t.rateLimitEvents > 0,
  ).length;

  let mc: McNemarResult | null = null;
  let mcOmitted: string | null = null;
  if (input.nTrialsPerTask !== 1) {
    mcOmitted = `McNemar needs 1 binary outcome per (task, config) pair; this experiment has ${input.nTrialsPerTask} trials per task`;
  } else if (rates.length === 0) {
    mcOmitted = 'no paired tasks';
  } else {
    mc = mcnemar(rates.map((r) => [r.ra === 1, r.rb === 1] as const));
  }

  // Cost, latency, tokens: per config the mean of per-task means over done trials, task-level bootstrap.
  const metric = (pick: (t: CompareTrial) => number | null): MetricComparison => {
    const taskMeans = (ts: CompareTrial[]): number | null => {
      const vs = ts.map(pick).filter((v): v is number => v !== null);
      return vs.length === 0 ? null : mean(vs);
    };
    const rows = headline.map((p) => {
      const slot = byTask.get(p.task.id)!;
      return { a: taskMeans(slot.a), b: taskMeans(slot.b) };
    });
    const as = rows.map((r) => r.a).filter((v): v is number => v !== null);
    const bs = rows.map((r) => r.b).filter((v): v is number => v !== null);
    const both = rows.filter((r): r is { a: number; b: number } => r.a !== null && r.b !== null);
    const delta =
      both.length === 0 ? null : percentileBootstrap(both, (s) => mean(s.map((r) => r.a - r.b)), resamples, seed);
    return {
      a: metricBlock(as, resamples, seed),
      b: metricBlock(bs, resamples, seed),
      delta_ci: delta === null ? null : [delta.ciLow, delta.ciHigh],
    };
  };

  return {
    experiment_id: input.experimentId,
    config_a: { id: idA, name: input.configA.name },
    config_b: { id: idB, name: input.configB.name },
    axis: input.axis,
    n_tasks: headline.length,
    n_trials_per_task: input.nTrialsPerTask,
    n_scored: nScored,
    n_excluded: nExcluded,
    n_unfinished: nUnfinished,
    // An unpaired task that is not judge-excluded is silently absent from the headline, so it makes the result partial.
    reliability: nExcluded === 0 && nUnfinished === 0 && unpairedInHeadline === 0 ? 'complete' : 'partial',
    rate_limit_affected_trials: rateLimitAffected,
    judge_policy_applied: policy,
    judge_confidence: policy === 'flagged' ? 'low' : null,
    judge: { model_id: opts.judge.modelId, prompt_hash: opts.judge.promptHash, kappa: opts.judge.kappa, policy },
    judge_excluded_tasks: judgeExcluded,
    unpaired_tasks: unpaired,
    ci_method: 'percentile',
    aggregate: pairedBlock(pairsOf(rates), resamples, seed),
    by_category: {
      memory_dependent: category('memory_dependent'),
      memory_distractor: category('memory_distractor'),
      neutral: category('neutral'),
      honesty: category('honesty'),
    },
    sign_test: signTest(pairsOf(rates)),
    mcnemar: mc,
    mcnemar_omitted: mcOmitted,
    per_task: perTask,
    failures,
    failures_judge_excluded: failuresJudgeExcluded,
    cost: metric((t) => t.costUsd),
    latency_ms: metric((t) => t.latencyMs),
    tokens: { input: metric((t) => t.inputTokens), output: metric((t) => t.outputTokens) },
    stats_version: STATS_VERSION,
  };
}
