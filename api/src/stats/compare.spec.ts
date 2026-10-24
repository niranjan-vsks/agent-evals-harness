import { mulberry32, percentileBootstrap } from './bootstrap';
import { compare, CompareInput, CompareOptions, CompareTask, CompareTrial, MIN_PAIRED_TASKS, noiseRule, TaskCategory } from './compare';
import { STATS_VERSION } from './version';

const A = { id: 'cfg-a', name: 'A' };
const B = { id: 'cfg-b', name: 'B' };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

const task = (id: string, category: TaskCategory = 'neutral_deterministic', judged = false): CompareTask => ({ id, category, judged });

function trial(configId: string, taskId: string, trialIndex: number, over: Partial<CompareTrial> = {}): CompareTrial {
  return {
    configId, taskId, trialIndex, status: 'done', passed: true,
    costUsd: null, latencyMs: null, inputTokens: null, outputTokens: null, rateLimitEvents: 0, ...over,
  }; // prettier-ignore
}

/** Done trials of one config on one task, 1 per outcome. */
const cell = (configId: string, taskId: string, outcomes: boolean[], over: Partial<CompareTrial> = {}) =>
  outcomes.map((passed, i) => trial(configId, taskId, i, { passed, ...over }));

/** tasks t1..tK with the given outcomes for A and B (arrays of booleans per task). */
function vector(aOut: boolean[][], bOut: boolean[][], categories?: TaskCategory[]): CompareInput {
  const tasks = aOut.map((_, i) => task(`t${i + 1}`, categories?.[i]));
  return {
    experimentId: 'exp-1', axis: 'memory', configA: A, configB: B, nTrialsPerTask: Math.max(...aOut.map((x) => x.length)), tasks,
    trials: aOut.flatMap((o, i) => [...cell(A.id, `t${i + 1}`, o), ...cell(B.id, `t${i + 1}`, bOut[i])]),
  };
}

const JUDGE_OFF: CompareOptions['judge'] = { policy: 'trusted', modelId: null, promptHash: null, kappa: null };
const opts = (over: Partial<CompareOptions> = {}): CompareOptions => ({ seed: 20261020, judge: JUDGE_OFF, ...over });

/** The 27 equally likely resamples of 3 tasks: every ordered triple of indices. */
function enumerate(deltas: number[]): number[] {
  const out: number[] = [];
  for (const i of [0, 1, 2]) for (const j of [0, 1, 2]) for (const k of [0, 1, 2]) out.push((deltas[i] + deltas[j] + deltas[k]) / 3);
  return out.sort((x, y) => x - y);
}

describe('3-task toy vectors, checked by enumeration', () => {
  // N = 2 per cell, so a rate is 0, 0.5 or 1.
  const T = true;
  const F = false;
  const vectors = [
    { name: 'mixed signs', a: [[T, T], [T, F], [F, F]], b: [[F, F], [T, F], [T, F]], deltas: [1, 0, -0.5], verdict: 'noise' },
    { name: 'all positive', a: [[T, T], [T, T], [T, F]], b: [[T, F], [F, F], [F, F]], deltas: [0.5, 1, 0.5], verdict: 'A_better' },
    { name: 'all negative', a: [[F, F], [T, F], [F, F]], b: [[T, T], [T, T], [T, F]], deltas: [-1, -0.5, -0.5], verdict: 'B_better' },
  ] as const;

  it.each(vectors)('$name: observed delta is the hand mean and the CI is exactly [min, max] of the 3 deltas', (v) => {
    const out = compare(vector(v.a.map((x) => [...x]), v.b.map((x) => [...x])), opts());
    const dist = enumerate([...v.deltas]);
    // the lowest and highest resample each have probability 1/27 = 3.7 percent > 2.5 percent, so the exact
    // 2.5 and 97.5 percent points of the 27-point distribution are its min and max
    const min = Math.min(...v.deltas);
    const max = Math.max(...v.deltas);
    expect(dist[0]).toBeCloseTo(min, 12);
    expect(dist[26]).toBeCloseTo(max, 12);
    expect(out.aggregate.delta).toBeCloseTo(mean([...v.deltas]), 12);
    expect(out.aggregate.ci_low).toBeCloseTo(min, 12);
    expect(out.aggregate.ci_high).toBeCloseTo(max, 12);
    expect(out.aggregate.verdict).toBe(v.verdict);
    expect(out.aggregate.min_detectable).toBeCloseTo((max - min) / 2, 12);
    expect(out.aggregate).toMatchObject({ resamples: 10000, seed: 20261020 });
    expect(out.n_tasks).toBe(3);
  });

  it('hand-computed pass rates: vector 1 has p_a = 0.5 and p_b = 1/3', () => {
    const v = vectors[0];
    const out = compare(vector(v.a.map((x) => [...x]), v.b.map((x) => [...x])), opts());
    expect(out.aggregate.p_a).toBeCloseTo(0.5, 12);
    expect(out.aggregate.p_b).toBeCloseTo(0.5 - 1 / 6, 12);
    expect(out.aggregate.delta).toBeCloseTo(1 / 6, 12);
  });

  it.each(vectors)(
    '$name: percentileBootstrap with 10000 resamples and the stored seed agrees with the enumerated distribution within 0.01',
    (v) => {
      const pairs = v.deltas.map((d) => [d, 0] as [number, number]);
      const sampleMeans: number[] = [];
      const r = percentileBootstrap(pairs, (s) => {
        const m = mean(s.map(([a, b]) => a - b));
        sampleMeans.push(m);
        return m;
      }, 10000, 20261020);
      sampleMeans.pop(); // the last call is the observed statistic
      const dist = enumerate([...v.deltas]);
      expect(sampleMeans).toHaveLength(10000);
      expect(Math.abs(mean(sampleMeans) - mean(dist))).toBeLessThan(0.01);
      expect(Math.abs(r.ciLow - dist[0])).toBeLessThan(0.01);
      expect(Math.abs(r.ciHigh - dist[26])).toBeLessThan(0.01);
      expect(Math.abs(Math.min(...sampleMeans) - dist[0])).toBeLessThan(0.01);
      expect(Math.abs(Math.max(...sampleMeans) - dist[26])).toBeLessThan(0.01);
      // and the shape, not only the extremes: the share of resamples at the minimum is near 1/27 or its exact multiplicity
      const atMin = sampleMeans.filter((m) => Math.abs(m - dist[0]) < 1e-12).length / 10000;
      const exactAtMin = dist.filter((m) => Math.abs(m - dist[0]) < 1e-12).length / 27;
      expect(Math.abs(atMin - exactAtMin)).toBeLessThan(0.02);
    },
  );
});

describe('noise rule (DESIGN 9.4)', () => {
  it('noiseRule: strictly inside, strictly above, strictly below', () => {
    expect(noiseRule(0.1, -0.2, 0.4)).toBe('noise');
    expect(noiseRule(0.3, 0.1, 0.5)).toBe('A_better');
    expect(noiseRule(-0.3, -0.5, -0.1)).toBe('B_better');
  });

  it('noiseRule: exactly on the boundary is noise on both sides (CI_low = 0, CI_high = 0)', () => {
    expect(noiseRule(0.4, 0, 0.8)).toBe('noise');
    expect(noiseRule(-0.4, -0.8, 0)).toBe('noise');
    expect(noiseRule(0, 0, 0)).toBe('noise');
    expect(noiseRule(0.4, -0, 0.8)).toBe('noise');
  });

  it('noiseRule: one hair across the boundary flips the verdict, float dust does not', () => {
    expect(noiseRule(0.4, 1e-9, 0.8)).toBe('A_better');
    expect(noiseRule(0.4, -1e-9, 0.8)).toBe('noise');
    expect(noiseRule(-0.4, -0.8, -1e-9)).toBe('B_better');
    expect(noiseRule(-0.4, -0.8, 1e-9)).toBe('noise');
    expect(noiseRule(0.4, 1e-17, 0.8)).toBe('noise');
  });

  it('compare: deltas [0, 1, 1] give CI [0, 1] and CI_low = 0 is noise, although delta is 2/3', () => {
    const out = compare(vector([[true], [true], [true]], [[true], [false], [false]]), opts());
    expect(out.aggregate.delta).toBeCloseTo(2 / 3, 12);
    expect(out.aggregate.ci_low).toBe(0);
    expect(out.aggregate.ci_high).toBe(1);
    expect(out.aggregate.verdict).toBe('noise');
  });

  it('compare: lifting the smallest delta from 0 to 1/2 (CI [1/2, 1]) crosses the boundary to A_better', () => {
    // N = 2: deltas 0.5, 1, 1
    const out = compare(
      vector([[true, true], [true, true], [true, true]], [[true, false], [false, false], [false, false]]),
      opts(),
    );
    expect(out.aggregate.ci_low).toBeCloseTo(0.5, 12);
    expect(out.aggregate.verdict).toBe('A_better');
  });

  it('compare: deltas [-1, 0, 0] give CI_high = 0 exactly and that is noise', () => {
    const out = compare(vector([[false], [true], [true]], [[true], [true], [true]]), opts());
    expect(out.aggregate.ci_high).toBe(0);
    expect(out.aggregate.ci_low).toBe(-1);
    expect(out.aggregate.verdict).toBe('noise');
  });
});

describe('reliability, exclusions, unpaired tasks', () => {
  function messy(): CompareInput {
    return {
      experimentId: 'e', axis: null, configA: A, configB: B, nTrialsPerTask: 2,
      tasks: [task('t1'), task('t2'), task('t3'), task('t4')],
      trials: [
        ...cell(A.id, 't1', [true, true]), ...cell(B.id, 't1', [false, true]),
        // t2: A has 1 done + 1 errored; B has 2 done
        trial(A.id, 't2', 0, { passed: true }), trial(A.id, 't2', 1, { status: 'errored', passed: null }), ...cell(B.id, 't2', [false, false]),
        // t3: A done, B all errored (+ a cancelled one)
        ...cell(A.id, 't3', [true, true]),
        trial(B.id, 't3', 0, { status: 'errored', passed: null }), trial(B.id, 't3', 1, { status: 'cancelled', passed: null }),
        // t4: nothing finished
        trial(A.id, 't4', 0, { status: 'running', passed: null }), trial(B.id, 't4', 0, { status: 'pending', passed: null }),
      ],
    };
  }

  it('scores only done trials, counts errored and cancelled in n_excluded, pending and running in n_unfinished', () => {
    const out = compare(messy(), opts());
    expect(out.n_excluded).toBe(3); // 2 errored + 1 cancelled
    expect(out.n_unfinished).toBe(2);
    expect(out.reliability).toBe('partial');
    expect(out.n_tasks).toBe(2); // t1, t2
    expect(out.n_scored).toBe(2 + 2 + 1 + 2); // t1: 2+2, t2: 1+2 (t3, t4 are unpaired and not in the headline)
    const t2 = out.per_task.find((r) => r.task_id === 't2')!;
    expect(t2).toMatchObject({ n_a: 1, n_b: 2, rate_a: 1, rate_b: 0, delta: 1 });
  });

  it('lists unpaired tasks with the reason, in task id order, and keeps them out of the headline', () => {
    const out = compare(messy(), opts());
    expect(out.unpaired_tasks).toEqual([
      { task_id: 't3', reason: 'no scored trial for config B' },
      { task_id: 't4', reason: 'no scored trial for either config' },
    ]);
    expect(out.per_task.map((r) => r.task_id)).toEqual(['t1', 't2']);
    expect(out.aggregate.p_a).toBeCloseTo((1 + 1) / 2, 12);
    expect(out.aggregate.p_b).toBeCloseTo((0.5 + 0) / 2, 12);
  });

  it('flags A-missing as config A', () => {
    const inp: CompareInput = { ...messy(), tasks: [task('t1'), task('t5')], trials: [...cell(A.id, 't1', [true]), ...cell(B.id, 't1', [true]), ...cell(B.id, 't5', [true])] };
    expect(compare(inp, opts()).unpaired_tasks).toEqual([{ task_id: 't5', reason: 'no scored trial for config A' }]);
  });

  it('is complete only when nothing is excluded or unfinished', () => {
    const clean = compare(vector([[true, false], [true, true]], [[false, false], [true, false]]), opts());
    expect(clean).toMatchObject({ n_excluded: 0, n_unfinished: 0, reliability: 'complete', n_scored: 8 });
    const withErr = vector([[true, false], [true, true]], [[false, false], [true, false]]);
    withErr.trials.push(trial(A.id, 't1', 2, { status: 'errored', passed: null }));
    expect(compare(withErr, opts())).toMatchObject({ n_excluded: 1, n_unfinished: 0, reliability: 'partial', n_scored: 8 });
    const withPending = vector([[true]], [[true]]);
    withPending.trials.push(trial(B.id, 't1', 1, { status: 'pending', passed: null }));
    expect(compare(withPending, opts())).toMatchObject({ n_excluded: 0, n_unfinished: 1, reliability: 'partial' });
  });

  it('a done trial with no verdict is not a pass and not a fail: it stays out of the rates and counts in n_excluded', () => {
    const inp = vector([[true, true]], [[false, false]]);
    inp.trials.push(trial(A.id, 't1', 2, { passed: null }));
    const out = compare(inp, opts());
    expect(out.per_task[0]).toMatchObject({ n_a: 2, rate_a: 1 });
    expect(out.n_scored).toBe(4);
    expect(out.n_excluded).toBe(1);
    expect(out.reliability).toBe('partial');
  });

  it('a task whose only done trial on one side has no verdict is unpaired with the "no scored trial" reason, and the result is partial', () => {
    const inp: CompareInput = {
      experimentId: 'e', axis: null, configA: A, configB: B, nTrialsPerTask: 1, tasks: [task('t1')],
      trials: [trial(A.id, 't1', 0, { passed: true }), trial(B.id, 't1', 0, { passed: null })],
    };
    const out = compare(inp, opts());
    expect(out.unpaired_tasks).toEqual([{ task_id: 't1', reason: 'no scored trial for config B' }]);
    expect(out).toMatchObject({ n_excluded: 1, n_unfinished: 0, reliability: 'partial', n_tasks: 0 });
  });

  it('is partial when a task has no trial rows at all, although nothing is excluded or unfinished', () => {
    const inp = vector([[true], [true], [true]], [[false], [true], [true]]);
    inp.tasks.push(task('t9'));
    const out = compare(inp, opts());
    expect(out).toMatchObject({ n_excluded: 0, n_unfinished: 0, reliability: 'partial' });
    expect(out.unpaired_tasks).toEqual([{ task_id: 't9', reason: 'no scored trial for either config' }]);
  });

  it('an unpaired judge-excluded task does not by itself make the result partial', () => {
    const inp = vector([[true], [true], [true]], [[false], [true], [true]]);
    inp.tasks.push(task('jdg-09', 'neutral_judged', true));
    const excluded = compare(inp, opts({ judge: { policy: 'excluded', modelId: 'm', promptHash: 'h', kappa: 0.1 } }));
    expect(excluded.reliability).toBe('complete');
    expect(excluded.judge_excluded_tasks).toEqual(['jdg-09']);
    const trusted = compare(inp, opts({ judge: { policy: 'trusted', modelId: 'm', promptHash: 'h', kappa: 0.9 } }));
    expect(trusted.reliability).toBe('partial');
  });

  it('counts only done, graded trials that hit a rate limit; errored ones never entered the headline', () => {
    const inp = vector([[true, true]], [[false, true]]);
    inp.trials[0].rateLimitEvents = 2;
    inp.trials[2].rateLimitEvents = 1;
    inp.trials.push(trial(B.id, 't1', 2, { status: 'errored', passed: null, rateLimitEvents: 1 }));
    expect(compare(inp, opts()).rate_limit_affected_trials).toBe(2);
  });

  it('3 errored rate_limited trials and 10 clean done trials report 0', () => {
    const inp = vector([[true, true, true, true, true]], [[true, false, true, false, true]]);
    for (let i = 0; i < 3; i++) inp.trials.push(trial(A.id, 't1', 10 + i, { status: 'errored', passed: null, rateLimitEvents: 2 }));
    const out = compare(inp, opts());
    expect(out.n_scored).toBe(10);
    expect(out.n_excluded).toBe(3);
    expect(out.rate_limit_affected_trials).toBe(0);
  });

  it('a rate-limited trial of a judge-withheld task is not counted', () => {
    const inp: CompareInput = {
      experimentId: 'e', axis: null, configA: A, configB: B, nTrialsPerTask: 1,
      tasks: [task('det-01'), task('jdg-01', 'neutral_judged', true)],
      trials: ['det-01', 'jdg-01'].flatMap((id) => [trial(A.id, id, 0, { rateLimitEvents: 1 }), trial(B.id, id, 0, { passed: false })]),
    };
    const excluded = opts({ judge: { policy: 'excluded', modelId: null, promptHash: null, kappa: null } });
    expect(compare(inp, excluded).rate_limit_affected_trials).toBe(1);
    expect(compare(inp, opts()).rate_limit_affected_trials).toBe(2);
  });

  it('ignores trials of other configs', () => {
    const inp = vector([[true]], [[true]]);
    inp.trials.push(trial('cfg-z', 't1', 0, { status: 'errored', passed: null }));
    expect(compare(inp, opts()).n_excluded).toBe(0);
  });
});

describe('judge policy', () => {
  const tasks = [task('det-01'), task('jdg-01', 'neutral_judged', true), task('jdg-02', 'honesty', true), task('mem-01', 'memory_dependent')];
  function input(): CompareInput {
    return {
      experimentId: 'e', axis: null, configA: A, configB: B, nTrialsPerTask: 1, tasks,
      trials: [
        trial(A.id, 'det-01', 0, { passed: true, costUsd: 1 }), trial(B.id, 'det-01', 0, { passed: false, costUsd: 1 }),
        trial(A.id, 'jdg-01', 0, { passed: true, costUsd: 100 }), trial(B.id, 'jdg-01', 0, { passed: false, costUsd: 100 }),
        trial(A.id, 'jdg-02', 0, { passed: true, costUsd: 100 }), trial(B.id, 'jdg-02', 0, { passed: false, costUsd: 100 }),
        trial(A.id, 'mem-01', 0, { passed: false, costUsd: 3 }), trial(B.id, 'mem-01', 0, { passed: false, costUsd: 3 }),
      ],
    };
  }
  const judge = (policy: 'trusted' | 'flagged' | 'excluded') => ({ policy, modelId: 'model-a', promptHash: 'sha-1', kappa: 0.55 });

  it('excluded: judged tasks leave every headline number and are listed; their per-task rows keep the numbers, badged', () => {
    const out = compare(input(), opts({ judge: judge('excluded') }));
    expect(out.judge_policy_applied).toBe('excluded');
    expect(out.judge_confidence).toBeNull();
    expect(out.judge_excluded_tasks).toEqual(['jdg-01', 'jdg-02']);
    expect(out.n_tasks).toBe(2);
    expect(out.n_scored).toBe(4);
    expect(out.aggregate.p_a).toBeCloseTo(0.5, 12);
    expect(out.aggregate.p_b).toBe(0);
    expect(out.sign_test).toMatchObject({ a_wins: 1, b_wins: 0, ties: 1 });
    expect(out.mcnemar).toMatchObject({ a_only: 1, b_only: 0, n_pairs: 2 });
    expect(out.by_category.honesty).toBeNull();
    expect(out.by_category.neutral).toMatchObject({ n_tasks: 1, delta: 1 }); // det-01 only: the judged neutral task is out
    expect(out.cost.a.mean).toBe((1 + 3) / 2); // the 100-cost judged tasks are out
    const row = out.per_task.find((r) => r.task_id === 'jdg-01')!;
    // 1 trial per side: the numbers stay, the CI does not exist (fewer than 2 trials on a side)
    expect(row).toMatchObject({
      judge_excluded: true, rate_a: 1, rate_b: 0, delta: 1, ci_low: null, ci_high: null, verdict: 'insufficient_data', n_a: 1, n_b: 1,
    });
    expect(out.per_task.find((r) => r.task_id === 'det-01')!.judge_excluded).toBe(false);
  });

  it('excluded: a judged task with many trials keeps its full row (rates, delta, CI, verdict) and stays out of every headline number', () => {
    const inp: CompareInput = {
      experimentId: 'e', axis: null, configA: A, configB: B, nTrialsPerTask: 3, tasks: [task('det-01'), task('jdg-01', 'neutral_judged', true)],
      trials: [
        ...cell(A.id, 'det-01', [true, true, true], { costUsd: 1 }), ...cell(B.id, 'det-01', [false, false, false], { costUsd: 1 }),
        ...cell(A.id, 'jdg-01', [true, true, true], { costUsd: 50 }), ...cell(B.id, 'jdg-01', [false, false, false], { costUsd: 50 }),
      ],
    };
    const out = compare(inp, opts({ judge: judge('excluded') }));
    const row = out.per_task.find((r) => r.task_id === 'jdg-01')!;
    expect(row).toMatchObject({ judge_excluded: true, rate_a: 1, rate_b: 0, delta: 1, ci_low: 1, ci_high: 1, verdict: 'A_better' });
    expect(out.n_tasks).toBe(1);
    expect(out.n_scored).toBe(6);
    expect(out.cost.a.mean).toBe(1);
    expect(out.sign_test.a_wins).toBe(1);
    expect(out.mcnemar_omitted).toContain('3 trials per task');
    expect(out.by_category.neutral).toMatchObject({ n_tasks: 1 });
  });

  it('excluded: a neutral_judged task is excluded even when the caller forgot the judged flag', () => {
    const inp: CompareInput = {
      experimentId: 'e', axis: null, configA: A, configB: B, nTrialsPerTask: 1, tasks: [task('det-01'), task('jdg-01', 'neutral_judged', false)],
      trials: [
        trial(A.id, 'det-01', 0, { passed: true }), trial(B.id, 'det-01', 0, { passed: false }),
        trial(A.id, 'jdg-01', 0, { passed: true }), trial(B.id, 'jdg-01', 0, { passed: false }),
      ],
    };
    const out = compare(inp, opts({ judge: judge('excluded') }));
    expect(out.judge_excluded_tasks).toEqual(['jdg-01']);
    expect(out.n_tasks).toBe(1);
    expect(out.n_scored).toBe(2);
    expect(out.sign_test).toMatchObject({ a_wins: 1, b_wins: 0, ties: 0 });
    expect(out.per_task.find((r) => r.task_id === 'jdg-01')!.judge_excluded).toBe(true);
    // under a trusted judge the same task is an ordinary headline task
    expect(compare(inp, opts({ judge: judge('trusted') })).n_tasks).toBe(2);
  });

  it('flagged: judged tasks count, the result is marked judge_confidence low, nothing is excluded', () => {
    const out = compare(input(), opts({ judge: judge('flagged') }));
    expect(out.judge_policy_applied).toBe('flagged');
    expect(out.judge_confidence).toBe('low');
    expect(out.judge_excluded_tasks).toEqual([]);
    expect(out.n_tasks).toBe(4);
    expect(out.n_scored).toBe(8);
    expect(out.aggregate.p_a).toBeCloseTo(0.75, 12);
    expect(out.per_task.every((r) => !r.judge_excluded && r.rate_a !== null)).toBe(true);
    expect(out.by_category.honesty).toMatchObject({ n_tasks: 1, delta: 1 });
    expect(out.judge).toEqual({ model_id: 'model-a', prompt_hash: 'sha-1', kappa: 0.55, policy: 'flagged' });
  });

  it('trusted: same numbers as flagged, no low-confidence mark', () => {
    const flagged = compare(input(), opts({ judge: judge('flagged') }));
    const trusted = compare(input(), opts({ judge: judge('trusted') }));
    expect(trusted.judge_confidence).toBeNull();
    expect(trusted.judge_excluded_tasks).toEqual([]);
    expect(trusted.aggregate).toEqual(flagged.aggregate);
    expect(trusted.judge.policy).toBe('trusted');
  });

  it('a set with no judged task is unaffected by the policy', () => {
    const inp: CompareInput = { ...input(), tasks: [task('det-01'), task('mem-01', 'memory_dependent')] };
    expect(compare(inp, opts({ judge: judge('excluded') })).judge_excluded_tasks).toEqual([]);
    expect(compare(inp, opts({ judge: judge('excluded') })).n_tasks).toBe(2);
  });
});

describe('categories', () => {
  it('has the 4 keys, merges neutral_deterministic and neutral_judged, counts tasks, and is null when empty', () => {
    const cats: TaskCategory[] = ['memory_dependent', 'memory_dependent', 'neutral_deterministic', 'neutral_judged', 'neutral_judged'];
    const inp = vector([[true], [true], [true], [false], [true]], [[false], [true], [true], [false], [false]], cats);
    inp.tasks = inp.tasks.map((t, i) => ({ ...t, judged: cats[i] === 'neutral_judged' }));
    const out = compare(inp, opts());
    expect(Object.keys(out.by_category)).toEqual(['memory_dependent', 'memory_distractor', 'neutral', 'honesty']);
    expect(out.by_category.memory_dependent).toMatchObject({ n_tasks: 2, p_a: 1, p_b: 0.5, delta: 0.5, seed: 20261020, resamples: 10000 });
    expect(out.by_category.neutral).toMatchObject({ n_tasks: 3 });
    expect(out.by_category.neutral!.delta).toBeCloseTo(1 / 3, 12);
    expect(out.by_category.memory_distractor).toBeNull();
    expect(out.by_category.honesty).toBeNull();
    expect(out.per_task.map((r) => r.category)).toEqual(cats);
  });

  it('a category CI is the bootstrap over its own tasks: 3 tasks with deltas 1, 0, 0 give [0, 1], noise', () => {
    const inp = vector([[true], [true], [true]], [[false], [true], [true]], ['honesty', 'honesty', 'honesty']);
    const h = compare(inp, opts()).by_category.honesty!;
    expect([h.ci_low, h.ci_high]).toEqual([0, 1]);
    expect(h.verdict).toBe('noise');
    expect(h.reason).toBeUndefined();
  });
});

describe('sign test and McNemar inside compare', () => {
  it('sign test counts tasks on rates; McNemar is computed when N = 1 with the exact discordant p', () => {
    // (A, B): (1,0) (1,0) (0,1) (1,1) -> a_only 2, b_only 1, both 1
    const inp = vector([[true], [true], [false], [true]], [[false], [false], [true], [true]]);
    const out = compare(inp, opts());
    expect(out.sign_test).toEqual({ a_wins: 2, b_wins: 1, ties: 1, p_value: 1 }); // n = 3, k = 1: 2 * 4 / 8 = 1
    expect(out.mcnemar).toEqual({ a_only: 2, b_only: 1, both_pass: 1, both_fail: 0, n_pairs: 4, n_discordant: 3, p_value: 1 });
    expect(out.mcnemar_omitted).toBeNull();
  });

  it('sign test p of 9 vs 2 with 11 ties through compare is 0.0654296875', () => {
    const aOut = [...Array(9).fill([true]), ...Array(2).fill([false]), ...Array(11).fill([true])];
    const bOut = [...Array(9).fill([false]), ...Array(2).fill([true]), ...Array(11).fill([true])];
    const out = compare(vector(aOut, bOut), opts({ resamples: 200, perTaskResamples: 20 }));
    expect(out.sign_test).toEqual({ a_wins: 9, b_wins: 2, ties: 11, p_value: 0.0654296875 });
    expect(out.mcnemar!.p_value).toBe(0.0654296875);
    expect(out.n_tasks).toBe(22);
  });

  it('with N > 1 McNemar is null and says why; the sign test still runs on rates', () => {
    const out = compare(vector([[true, true], [true, false]], [[false, false], [true, false]]), opts());
    expect(out.mcnemar).toBeNull();
    expect(out.mcnemar_omitted).toContain('2 trials per task');
    expect(out.sign_test).toEqual({ a_wins: 1, b_wins: 0, ties: 1, p_value: 1 });
  });
});

describe('per-task rows', () => {
  it('carry the DESIGN 9.6 columns and direction_only', () => {
    const out = compare(vector([[true, true]], [[false, false]]), opts());
    expect(Object.keys(out.per_task[0]).sort()).toEqual(
      ['task_id', 'category', 'n_a', 'n_b', 'rate_a', 'rate_b', 'delta', 'ci_low', 'ci_high', 'verdict', 'direction_only', 'judge_excluded'].sort(),
    );
    expect(out.per_task[0].direction_only).toBe(true);
  });

  it('resamples A and B separately: 2 vs 2 identical outcomes give CI [1, 1]; mixed 4 vs 4 straddles 0', () => {
    const sure = compare(vector([[true, true]], [[false, false]]), opts()).per_task[0];
    expect([sure.ci_low, sure.ci_high, sure.delta, sure.verdict]).toEqual([1, 1, 1, 'A_better']);
    const mixed = compare(vector([[true, false, true, false]], [[true, false, false, true]]), opts()).per_task[0];
    expect(mixed.delta).toBe(0);
    expect(mixed.ci_low).toBeLessThan(0);
    expect(mixed.ci_high).toBeGreaterThan(0);
    expect(mixed.verdict).toBe('noise');
    // separate resampling of 4 and 4 reaches -1 and +1; a joint resample of paired indices could not mix them
    expect(mixed.ci_low).toBeGreaterThanOrEqual(-1);
    expect(mixed.ci_high).toBeLessThanOrEqual(1);
  });

  it('handles unequal n per side: a side with fewer than 2 trials gives no CI and insufficient_data, the rates stay', () => {
    const row = compare(vector([[true, true, true]], [[false]]), opts()).per_task[0];
    expect(row).toMatchObject({ n_a: 3, n_b: 1, rate_a: 1, rate_b: 0, delta: 1, ci_low: null, ci_high: null, verdict: 'insufficient_data' });
    const both = compare(vector([[true, true, true]], [[false, false]]), opts()).per_task[0];
    expect(both).toMatchObject({ n_a: 3, n_b: 2, ci_low: 1, ci_high: 1, verdict: 'A_better' });
  });

  it('1 trial per side: rates and delta are reported, the CI is null and the verdict is insufficient_data', () => {
    const row = compare(vector([[true]], [[false]]), opts()).per_task[0];
    expect(row).toMatchObject({
      n_a: 1, n_b: 1, rate_a: 1, rate_b: 0, delta: 1, ci_low: null, ci_high: null, verdict: 'insufficient_data', direction_only: true,
    });
  });

  it('is reproducible per task and does not depend on the order tasks are passed in', () => {
    const inp = vector([[true, false, true], [true, true, false], [false, false, true]], [[false, false, true], [true, false, false], [true, true, true]]);
    const reversed: CompareInput = { ...inp, tasks: [...inp.tasks].reverse(), trials: [...inp.trials].reverse() };
    expect(compare(reversed, opts()).per_task).toEqual(compare(inp, opts()).per_task);
  });
});

describe('cost, latency and tokens (vector checked by hand)', () => {
  // N = 2. Per-task means A: 1, 2, 3 and B: 2, 2, 5 (task 2 of A has trials costing 1 and 3; one B trial has no cost recorded).
  function costInput(): CompareInput {
    const inp = vector([[true, true], [true, true], [true, true]], [[true, true], [true, true], [true, true]]);
    const costs: Record<string, Array<number | null>> = {
      'cfg-a|t1': [1, 1], 'cfg-a|t2': [1, 3], 'cfg-a|t3': [3, 3], 'cfg-b|t1': [2, 2], 'cfg-b|t2': [2, null], 'cfg-b|t3': [5, 5],
    };
    for (const t of inp.trials) {
      const c = costs[`${t.configId}|${t.taskId}`][t.trialIndex];
      t.costUsd = c;
      t.latencyMs = c === null ? null : c * 1000;
      t.inputTokens = c === null ? null : c * 10;
      t.outputTokens = 7;
    }
    return inp;
  }

  it('cost: mean of per-task means, task-level CI [min, max] of the 3 task means, and delta_ci of the paired difference', () => {
    const out = compare(costInput(), opts());
    expect(out.cost.a.mean).toBeCloseTo(2, 12);
    expect(out.cost.a.ci_low).toBeCloseTo(1, 12);
    expect(out.cost.a.ci_high).toBeCloseTo(3, 12);
    expect(out.cost.b.mean).toBeCloseTo(3, 12);
    expect(out.cost.b.ci_low).toBeCloseTo(2, 12);
    expect(out.cost.b.ci_high).toBeCloseTo(5, 12);
    // A - B per task: -1, 0, -2 -> mean -1, [-2, 0]
    expect(out.cost.delta_ci![0]).toBeCloseTo(-2, 12);
    expect(out.cost.delta_ci![1]).toBeCloseTo(0, 12);
  });

  it('latency is the same numbers times 1000 and tokens follow their own columns', () => {
    const out = compare(costInput(), opts());
    expect(out.latency_ms.a.mean).toBeCloseTo(2000, 9);
    expect(out.latency_ms.b.ci_high).toBeCloseTo(5000, 9);
    expect(out.latency_ms.delta_ci![0]).toBeCloseTo(-2000, 9);
    expect(out.tokens.input.a.mean).toBeCloseTo(20, 10);
    expect(out.tokens.input.delta_ci![0]).toBeCloseTo(-20, 10);
    expect(out.tokens.output.a).toEqual({ mean: 7, ci_low: 7, ci_high: 7 });
    expect(out.tokens.output.delta_ci).toEqual([0, 0]);
  });

  it('uses done trials only: an errored trial with a huge cost does not move the mean', () => {
    const inp = costInput();
    inp.trials.push(trial(A.id, 't1', 2, { status: 'errored', passed: null, costUsd: 1e6 }));
    expect(compare(inp, opts()).cost.a.mean).toBeCloseTo(2, 12);
  });

  it('gives nulls when nothing was recorded', () => {
    const out = compare(vector([[true]], [[true]]), opts());
    expect(out.cost).toEqual({ a: { mean: null, ci_low: null, ci_high: null }, b: { mean: null, ci_low: null, ci_high: null }, delta_ci: null });
  });
});

describe('minimum paired tasks (implementation guard)', () => {
  it('MIN_PAIRED_TASKS is 2', () => {
    expect(MIN_PAIRED_TASKS).toBe(2);
  });

  it('1 paired task: p_a, p_b and delta stay, the interval and min_detectable are null, the verdict is insufficient_data', () => {
    // A 3/3, B 0/3: a single-point interval would give A_better with CI [1, 1] and min_detectable 0
    const out = compare(vector([[true, true, true]], [[false, false, false]]), opts());
    expect(out.aggregate).toMatchObject({
      p_a: 1, p_b: 0, delta: 1, ci_low: null, ci_high: null, verdict: 'insufficient_data', min_detectable: null, resamples: 10000, seed: 20261020,
    });
    expect(out.aggregate.reason).toBe(
      '1 paired task(s); an interval needs at least 2 (a single task has no spread); see STATE.md (P3, Assumptions resolved)',
    );
    expect(out.n_tasks).toBe(1);
  });

  describe('2 paired tasks: the interval is exactly [min, max] of the 2 task deltas', () => {
    const T = true;
    const F = false;
    it.each([
      { name: 'both positive', a: [[T, T], [T, F]], b: [[F, F], [F, F]], lo: 0.5, hi: 1, verdict: 'A_better' },
      { name: 'both negative', a: [[F, F], [F, T]], b: [[T, T], [T, T]], lo: -1, hi: -0.5, verdict: 'B_better' },
      { name: 'mixed signs', a: [[T, T], [F, F]], b: [[F, F], [T, F]], lo: -0.5, hi: 1, verdict: 'noise' },
    ])('$name', (v) => {
      const out = compare(vector(v.a.map((x) => [...x]), v.b.map((x) => [...x])), opts());
      expect(out.n_tasks).toBe(2);
      expect(out.aggregate.ci_low).toBeCloseTo(v.lo, 12);
      expect(out.aggregate.ci_high).toBeCloseTo(v.hi, 12);
      expect(out.aggregate.delta).toBeCloseTo((v.lo + v.hi) / 2, 12);
      expect(out.aggregate.min_detectable).toBeCloseTo((v.hi - v.lo) / 2, 12);
      expect(out.aggregate.verdict).toBe(v.verdict);
      expect(out.aggregate.reason).toBeUndefined();
    });
  });

  it('the same holds for a category block with 1 task, even when the aggregate has enough; a 2-task category gets an interval', () => {
    const cats: TaskCategory[] = ['honesty', 'neutral_deterministic', 'neutral_deterministic', 'memory_distractor', 'memory_distractor'];
    const out = compare(vector(Array(5).fill([true]), [[false], [false], [true], [false], [false]], cats), opts());
    expect(out.aggregate.verdict).not.toBe('insufficient_data');
    expect(out.aggregate.ci_low).not.toBeNull();
    expect(out.by_category.honesty).toMatchObject({
      n_tasks: 1, p_a: 1, p_b: 0, delta: 1, ci_low: null, ci_high: null, verdict: 'insufficient_data', min_detectable: null,
    });
    expect(out.by_category.memory_distractor).toMatchObject({ n_tasks: 2, delta: 1, ci_low: 1, ci_high: 1, verdict: 'A_better' });
    expect(out.by_category.memory_distractor!.reason).toBeUndefined();
    expect(out.by_category.neutral).toMatchObject({ n_tasks: 2, delta: 0.5, ci_low: 0, ci_high: 1, verdict: 'noise' });
  });

  it('exactly 3 paired tasks passes the minimum and gets an interval', () => {
    const out = compare(vector([[true], [true], [true]], [[false], [false], [false]]), opts());
    expect(out.aggregate).toMatchObject({ ci_low: 1, ci_high: 1, verdict: 'A_better', min_detectable: 0 });
    expect(out.aggregate.reason).toBeUndefined();
  });

  it('the sign test and McNemar are unaffected by the minimum', () => {
    const out = compare(vector([[true]], [[false]]), opts());
    expect(out.aggregate.verdict).toBe('insufficient_data');
    expect(out.sign_test).toMatchObject({ a_wins: 1, b_wins: 0, ties: 0 });
    expect(out.mcnemar).toMatchObject({ a_only: 1, b_only: 0, n_pairs: 1 });
  });

  it('judge-excluded tasks do not count towards the minimum', () => {
    const inp: CompareInput = {
      experimentId: 'e', axis: null, configA: A, configB: B, nTrialsPerTask: 1,
      tasks: [task('det-01'), task('jdg-01', 'neutral_judged', true), task('jdg-02', 'neutral_judged', true)],
      trials: ['det-01', 'jdg-01', 'jdg-02'].flatMap((id) => [trial(A.id, id, 0, { passed: true }), trial(B.id, id, 0, { passed: false })]),
    };
    const excluded = opts({ judge: { policy: 'excluded', modelId: null, promptHash: null, kappa: null } });
    const trusted = opts({ judge: { policy: 'trusted', modelId: null, promptHash: null, kappa: null } });
    expect(compare(inp, excluded).aggregate.verdict).toBe('insufficient_data');
    expect(compare(inp, trusted).aggregate.verdict).toBe('A_better');
  });
});

describe('0 paired tasks', () => {
  it('returns insufficient_data and nulls without throwing, whatever is in the experiment', () => {
    const inputs: CompareInput[] = [
      { experimentId: 'e', axis: null, configA: A, configB: B, nTrialsPerTask: 3, tasks: [], trials: [] },
      { experimentId: 'e', axis: null, configA: A, configB: B, nTrialsPerTask: 3, tasks: [task('t1'), task('t2')], trials: [] },
      {
        experimentId: 'e', axis: null, configA: A, configB: B, nTrialsPerTask: 1, tasks: [task('t1')],
        trials: [...cell(A.id, 't1', [true]), trial(B.id, 't1', 0, { status: 'errored', passed: null })],
      },
    ];
    for (const inp of inputs) {
      const out = compare(inp, opts());
      expect(out.aggregate).toEqual({
        p_a: null, p_b: null, delta: null, ci_low: null, ci_high: null, verdict: 'insufficient_data', min_detectable: null, resamples: 10000, seed: 20261020,
      });
      expect(out.n_tasks).toBe(0);
      expect(out.per_task).toEqual([]);
      expect(out.by_category).toEqual({ memory_dependent: null, memory_distractor: null, neutral: null, honesty: null });
      expect(out.sign_test).toEqual({ a_wins: 0, b_wins: 0, ties: 0, p_value: 1 });
      expect(out.mcnemar).toBeNull();
      expect(out.mcnemar_omitted).toBeTruthy();
      expect(out.cost.delta_ci).toBeNull();
      expect(out.tokens.input.a.mean).toBeNull();
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });
});

describe('payload shape (DESIGN 9.6)', () => {
  const full = () => compare(vector([[true, false], [true, true], [false, true]], [[false, false], [true, false], [true, true]]), opts());

  it('has every key of the DESIGN 9.6 payload, plus the contract additions', () => {
    const out = full();
    const design = [
      'experiment_id', 'config_a', 'config_b', 'axis', 'n_tasks', 'n_trials_per_task', 'n_scored', 'n_excluded', 'reliability',
      'rate_limit_affected_trials', 'judge_policy_applied', 'judge_excluded_tasks', 'aggregate', 'by_category', 'sign_test', 'mcnemar',
      'per_task', 'cost', 'latency_ms', 'tokens', 'stats_version',
    ];
    const additions = ['ci_method', 'judge_confidence', 'judge', 'n_unfinished', 'unpaired_tasks', 'mcnemar_omitted'];
    expect(Object.keys(out).sort()).toEqual([...design, ...additions].sort());
    expect(Object.keys(out.aggregate).sort()).toEqual(
      ['p_a', 'p_b', 'delta', 'ci_low', 'ci_high', 'verdict', 'min_detectable', 'resamples', 'seed'].sort(),
    );
    expect(Object.keys(out.cost).sort()).toEqual(['a', 'b', 'delta_ci']);
    expect(Object.keys(out.tokens).sort()).toEqual(['input', 'output']);
    expect(Object.keys(out.latency_ms).sort()).toEqual(['a', 'b', 'delta_ci']);
    expect(Object.keys(out.judge).sort()).toEqual(['kappa', 'model_id', 'policy', 'prompt_hash']);
  });

  it('echoes the inputs and names the method', () => {
    const out = full();
    expect(out).toMatchObject({
      experiment_id: 'exp-1', config_a: A, config_b: B, axis: 'memory', n_trials_per_task: 2, ci_method: 'percentile',
      stats_version: STATS_VERSION, judge_policy_applied: 'trusted', judge_confidence: null,
    });
  });

  it('aggregate uses 10000 resamples and per-task 2000 by default', () => {
    const inp = vector([[true, false], [true, true], [false, false]], [[false, false], [true, false], [true, true]]);
    const dflt = compare(inp, opts());
    expect(dflt.aggregate.resamples).toBe(10000);
    expect(JSON.stringify(dflt)).toBe(JSON.stringify(compare(inp, opts({ resamples: 10000, perTaskResamples: 2000 }))));
    expect(JSON.stringify(dflt)).not.toBe(JSON.stringify(compare(inp, opts({ resamples: 500, perTaskResamples: 100 }))));
    expect(compare(inp, opts({ resamples: 500 })).aggregate.resamples).toBe(500);
  });
});

describe('determinism', () => {
  /** 8 tasks x 10 trials with varied pass rates (generated from a fixed seed) so a different seed visibly moves the intervals. */
  function bigger(): CompareInput {
    const rng = mulberry32(99);
    const pa = [0.9, 0.6, 0.3, 0.7, 0.2, 0.95, 0.4, 0.5];
    const pb = [0.3, 0.5, 0.1, 0.6, 0.5, 0.7, 0.45, 0.2];
    const draw = (ps: number[]) => ps.map((p) => Array.from({ length: 10 }, () => rng() < p));
    const inp = vector(draw(pa), draw(pb));
    inp.trials.forEach((t, i) => {
      t.costUsd = 0.01 + ((i * 37) % 101) / 1000;
      t.latencyMs = 1000 + ((i * 13) % 11) * 100;
      t.inputTokens = 100 + ((i * 3) % 7);
      t.outputTokens = 50 + ((i * 5) % 9);
    });
    return inp;
  }

  /** Remove everything that legitimately depends on the seed: the CI fields and what is derived from them. */
  function stripSeedDependent(x: unknown): unknown {
    if (Array.isArray(x)) return x.map(stripSeedDependent);
    if (x !== null && typeof x === 'object') {
      const drop = new Set(['ci_low', 'ci_high', 'delta_ci', 'verdict', 'min_detectable', 'seed']);
      return Object.fromEntries(Object.entries(x).filter(([k]) => !drop.has(k)).map(([k, v]) => [k, stripSeedDependent(v)]));
    }
    return x;
  }

  it('same input and seed give a byte-identical payload', () => {
    expect(JSON.stringify(compare(bigger(), opts()))).toBe(JSON.stringify(compare(bigger(), opts())));
  });

  /** Seeded Fisher-Yates: a permutation that does not preserve trialIndex order within a cell. */
  function permuted<T>(xs: readonly T[], seed: number): T[] {
    const out = [...xs];
    const rng = mulberry32(seed);
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  it('is unaffected by the order of trials and tasks: a full reverse and 2 seeded permutations give a byte-identical payload', () => {
    const inp = bigger();
    const expected = JSON.stringify(compare(inp, opts()));
    const reversed: CompareInput = { ...inp, trials: [...inp.trials].reverse(), tasks: [...inp.tasks].reverse() };
    expect(JSON.stringify(compare(reversed, opts()))).toBe(expected);
    for (const s of [7, 20261020]) {
      const shuffled: CompareInput = { ...inp, trials: permuted(inp.trials, s), tasks: permuted(inp.tasks, s + 1) };
      // the permutation really breaks the within-cell order, so the test fails if compare() stops sorting by trialIndex
      const firstCell = shuffled.trials.filter((t) => t.configId === A.id && t.taskId === 't1').map((t) => t.trialIndex);
      expect(firstCell).not.toEqual([...firstCell].sort((x, y) => x - y));
      expect(JSON.stringify(compare(shuffled, opts()))).toBe(expected);
    }
  });

  it('a different seed changes the CI fields and nothing else', () => {
    const one = compare(bigger(), opts({ seed: 1 }));
    const two = compare(bigger(), opts({ seed: 2 }));
    expect(JSON.stringify(one)).not.toBe(JSON.stringify(two));
    expect(one.per_task.map((r) => r.ci_low)).not.toEqual(two.per_task.map((r) => r.ci_low));
    expect(one.cost.a.ci_low).not.toBe(two.cost.a.ci_low);
    expect(JSON.stringify(stripSeedDependent(one))).toBe(JSON.stringify(stripSeedDependent(two)));
    expect(one.aggregate.seed).toBe(1);
    expect(two.aggregate.seed).toBe(2);
  });
});
