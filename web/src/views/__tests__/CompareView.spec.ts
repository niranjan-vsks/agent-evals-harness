import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { api, ApiError } from '../../api/client';
import type { AggregateBlock, ComparePayload, Config, ExperimentDetail, PerTaskRow } from '../../api/types';
import { routes } from '../../router';
import CompareView from '../CompareView.vue';
import { aggregate, category, makeCompare, makeConfig, makeExperiment, memoryOff, memorySeeded, perTask, realP3Payload, withAggregate } from './fixtures/compare';

const EXP = '01EXPERIMENT0000000000000A';
const A_ID = '01CONFIGA00000000000000000A';
const B_ID = '01CONFIGB00000000000000000B';

interface Setup {
  payload?: ComparePayload;
  compareError?: Error;
  experiment?: ExperimentDetail;
  experimentError?: Error;
  configs?: Config[];
  configsError?: Error;
  query?: string;
}

async function mountView(s: Setup = {}): Promise<{ wrapper: VueWrapper; router: ReturnType<typeof createRouter> }> {
  vi.spyOn(api, 'getExperiment').mockImplementation(() => (s.experimentError ? Promise.reject(s.experimentError) : Promise.resolve(s.experiment ?? makeExperiment())));
  vi.spyOn(api, 'compare').mockImplementation(() => (s.compareError ? Promise.reject(s.compareError) : Promise.resolve(s.payload ?? makeCompare())));
  vi.spyOn(api, 'listConfigs').mockImplementation(() => (s.configsError ? Promise.reject(s.configsError) : Promise.resolve(s.configs ?? [memoryOff(), memorySeeded()])));
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(`/experiments/${EXP}/compare${s.query ?? ''}`);
  await router.isReady();
  const wrapper = mount(CompareView, { props: { id: EXP }, global: { plugins: [createPinia(), router] } });
  await flushPromises();
  return { wrapper, router };
}

/** A payload with only the aggregate under test: no category cards and no per-task rows to add other verdict sentences. */
const isolated = (agg: Partial<AggregateBlock>, rest: Partial<ComparePayload> = {}): ComparePayload =>
  withAggregate(agg, { by_category: { memory_dependent: null, memory_distractor: null, neutral: null, honesty: null }, per_task: [], ...rest });

const text = (w: VueWrapper): string => w.text().replace(/\s+/g, ' ');
const tid = (w: VueWrapper, id: string): string => w.get(`[data-testid="${id}"]`).text().replace(/\s+/g, ' ');
const follows = (first: Element, second: Element): boolean => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CompareView verdict sentence', () => {
  it('shows noise when the interval contains 0', async () => {
    const { wrapper } = await mountView({ payload: isolated({ delta: 0.05, ci_low: -0.2, ci_high: 0.3, verdict: 'noise' }) });
    expect(tid(wrapper, 'verdict-aggregate')).toBe('noise: the interval contains 0');
    expect(text(wrapper)).toContain('noise: the interval contains 0');
    expect(text(wrapper)).not.toContain('A better');
    expect(text(wrapper)).not.toContain('B better');
    expect(text(wrapper)).not.toContain('payload inconsistent');
  });

  it('shows noise when ci_low is exactly 0', async () => {
    const { wrapper } = await mountView({ payload: isolated({ delta: 0.2, ci_low: 0, ci_high: 0.4, verdict: 'noise' }) });
    expect(tid(wrapper, 'verdict-aggregate')).toBe('noise: the interval contains 0');
    expect(text(wrapper)).toContain('noise: the interval contains 0');
    expect(text(wrapper)).not.toContain('payload inconsistent');
  });

  it('shows noise when ci_high is exactly 0', async () => {
    const { wrapper } = await mountView({ payload: realP3Payload });
    expect(realP3Payload.aggregate.ci_high).toBe(0);
    expect(tid(wrapper, 'verdict-aggregate')).toBe('noise: the interval contains 0');
    expect(text(wrapper)).not.toContain('payload inconsistent');
  });

  it('shows "A better by" with the margin and the interval when the interval is fully positive', async () => {
    const { wrapper } = await mountView({
      payload: isolated(
        { p_a: 0.8, p_b: 0.55, delta: 0.25, ci_low: 0.1, ci_high: 0.4, verdict: 'A_better' },
        { per_task: [perTask({ delta: 0.25, ci_low: 0.1, ci_high: 0.4, rate_a: 0.8, rate_b: 0.55, verdict: 'A_better' })] },
      ),
    });
    expect(tid(wrapper, 'verdict-aggregate')).toBe('A better by 0.250 [0.100, 0.400]');
    expect(text(wrapper)).not.toContain('noise');
    expect(text(wrapper)).not.toContain('payload inconsistent');
  });

  it('shows "B better by" with the negated margin and the swapped interval when the interval is fully negative', async () => {
    const { wrapper } = await mountView({
      payload: isolated(
        { p_a: 0.2, p_b: 0.5, delta: -0.3, ci_low: -0.5, ci_high: -0.1, verdict: 'B_better' },
        { per_task: [perTask({ delta: -0.3, ci_low: -0.5, ci_high: -0.1, rate_a: 0.2, rate_b: 0.5, verdict: 'B_better' })] },
      ),
    });
    expect(tid(wrapper, 'verdict-aggregate')).toBe('B better by 0.300 [0.100, 0.500]');
    expect(text(wrapper)).not.toContain('noise');
    expect(text(wrapper)).not.toContain('payload inconsistent');
    // the card says the tables are A - B while the sentence is the margin of the better config
    expect(tid(wrapper, 'aggregate')).toContain('intervals in the tables are A - B; the sentence states the margin of the better config');
    // and the table interval of the same aggregate stays A - B
    expect(tid(wrapper, 'metric-pass-rate')).toContain('-0.300 [-0.500, -0.100]');
  });

  it('flags a payload that says noise but whose interval excludes 0, and never prints the noise sentence', async () => {
    const { wrapper } = await mountView({ payload: isolated({ delta: 0.3, ci_low: 0.1, ci_high: 0.5, verdict: 'noise' }) });
    expect(tid(wrapper, 'verdict-aggregate')).toBe('payload inconsistent: verdict noise but interval [0.100, 0.500]');
    expect(wrapper.get('[data-testid="verdict-aggregate"]').classes()).toContain('warn');
    expect(text(wrapper)).not.toContain('noise: the interval contains 0');
    expect(text(wrapper)).not.toContain('better by');
  });

  it('flags a payload that says A_better but whose interval contains 0, and never prints a better-by sentence', async () => {
    const { wrapper } = await mountView({ payload: isolated({ delta: 0.2, ci_low: -0.1, ci_high: 0.5, verdict: 'A_better' }) });
    expect(tid(wrapper, 'verdict-aggregate')).toBe('payload inconsistent: verdict A_better but interval [-0.100, 0.500]');
    expect(text(wrapper)).not.toContain('A better by');
    expect(text(wrapper)).not.toContain('noise: the interval contains 0');
  });

  it('flags B_better whose interval contains 0', async () => {
    const { wrapper } = await mountView({ payload: isolated({ delta: -0.2, ci_low: -0.5, ci_high: 0.1, verdict: 'B_better' }) });
    expect(tid(wrapper, 'verdict-aggregate')).toContain('payload inconsistent: verdict B_better');
    expect(text(wrapper)).not.toContain('B better by');
  });

  it('flags a better verdict whose delta points the other way', async () => {
    const { wrapper } = await mountView({ payload: isolated({ delta: -0.3, ci_low: 0.1, ci_high: 0.5, verdict: 'A_better' }) });
    expect(tid(wrapper, 'verdict-aggregate')).toContain('payload inconsistent');
    expect(text(wrapper)).not.toContain('A better by');
  });

  it('flags A_better whose interval is fully negative even though delta is positive, with no better-by sentence', async () => {
    const { wrapper } = await mountView({ payload: isolated({ delta: 0.3, ci_low: -0.5, ci_high: -0.1, verdict: 'A_better' }) });
    expect(tid(wrapper, 'verdict-aggregate')).toBe('payload inconsistent: verdict A_better but interval [-0.500, -0.100]');
    expect(text(wrapper)).not.toContain('A better by');
    expect(text(wrapper)).not.toContain('B better by');
  });

  it('flags B_better whose interval is fully positive even though delta is negative, with no better-by sentence', async () => {
    const { wrapper } = await mountView({ payload: isolated({ delta: -0.3, ci_low: 0.1, ci_high: 0.5, verdict: 'B_better' }) });
    expect(tid(wrapper, 'verdict-aggregate')).toBe('payload inconsistent: verdict B_better but interval [0.100, 0.500]');
    expect(text(wrapper)).not.toContain('B better by');
    expect(text(wrapper)).not.toContain('A better by');
  });

  it('flags a non-insufficient verdict with a null interval bound', async () => {
    const { wrapper } = await mountView({ payload: isolated({ delta: 0.2, ci_low: null, ci_high: 0.4, verdict: 'noise' }) });
    expect(tid(wrapper, 'verdict-aggregate')).toBe('payload inconsistent: verdict noise but interval [n/a, 0.400]');
    expect(text(wrapper)).not.toContain('noise: the interval contains 0');
  });

  it('shows the reason for insufficient_data and makes no claim of better, worse or noise', async () => {
    const reason = 'only 1 paired task; an interval needs at least 2';
    const { wrapper } = await mountView({
      payload: isolated({ delta: 0.5, ci_low: null, ci_high: null, min_detectable: null, verdict: 'insufficient_data', reason }),
    });
    const block = tid(wrapper, 'aggregate');
    expect(tid(wrapper, 'verdict-aggregate')).toBe(`insufficient data: ${reason}`);
    expect(block).not.toContain('better by');
    expect(block).not.toContain('noise:');
    expect(block).not.toContain('A better');
    expect(block).not.toContain('B better');
  });

  it('uses a generic text for insufficient_data without a reason', async () => {
    const { wrapper } = await mountView({
      payload: isolated({ p_a: null, p_b: null, delta: null, ci_low: null, ci_high: null, min_detectable: null, verdict: 'insufficient_data' }),
    });
    expect(tid(wrapper, 'verdict-aggregate')).toBe('insufficient data: the API gave no reason');
    expect(tid(wrapper, 'verdict-aggregate')).not.toContain('paired');
    expect(tid(wrapper, 'aggregate')).not.toContain('noise:');
  });

  it('treats float dust around 0 as 0: ci_low 1e-17 with verdict noise is not an inconsistency', async () => {
    const { wrapper } = await mountView({ payload: isolated({ delta: 0.1, ci_low: 1e-17, ci_high: 0.3, verdict: 'noise' }) });
    expect(tid(wrapper, 'verdict-aggregate')).toBe('noise: the interval contains 0');
    expect(text(wrapper)).not.toContain('payload inconsistent');
  });

  it('treats a negative float dust ci_high as 0 as well', async () => {
    const { wrapper } = await mountView({ payload: isolated({ delta: -0.1, ci_low: -0.3, ci_high: -1e-17, verdict: 'noise' }) });
    expect(tid(wrapper, 'verdict-aggregate')).toBe('noise: the interval contains 0');
  });

  it('uses the same rules on category cards and per-task rows', async () => {
    const { wrapper } = await mountView({
      payload: makeCompare({
        by_category: {
          memory_dependent: category({ delta: 0.4, ci_low: 0.2, ci_high: 0.6, verdict: 'A_better' }),
          memory_distractor: category({ delta: -0.4, ci_low: -0.6, ci_high: -0.2, verdict: 'B_better' }),
          neutral: category({ delta: 0.1, ci_low: 0.05, ci_high: 0.3, verdict: 'noise' }),
          honesty: category({ delta: 0, ci_low: null, ci_high: null, verdict: 'insufficient_data', reason: 'a single task has no spread' }),
        },
        per_task: [
          perTask({ task_id: 't-a', delta: 0.5, ci_low: 0.2, ci_high: 0.8, verdict: 'A_better' }),
          perTask({ task_id: 't-b', delta: -0.5, ci_low: -0.8, ci_high: -0.2, verdict: 'B_better' }),
          perTask({ task_id: 't-n', delta: 0, ci_low: -0.1, ci_high: 0.1, verdict: 'noise' }),
          perTask({ task_id: 't-i', delta: 0, ci_low: null, ci_high: null, verdict: 'insufficient_data' }),
          perTask({ task_id: 't-x', delta: 0.5, ci_low: 0.2, ci_high: 0.8, verdict: 'noise' }),
        ],
      }),
    });
    expect(tid(wrapper, 'category-memory_dependent')).toContain('A better by 0.400 [0.200, 0.600]');
    expect(tid(wrapper, 'category-memory_distractor')).toContain('B better by 0.400 [0.200, 0.600]');
    expect(tid(wrapper, 'category-neutral')).toContain('payload inconsistent: verdict noise but interval [0.050, 0.300]');
    expect(tid(wrapper, 'category-neutral')).not.toContain('noise: the interval contains 0');
    expect(tid(wrapper, 'category-honesty')).toContain('insufficient data: a single task has no spread');
    expect(tid(wrapper, 'category-honesty')).not.toContain('noise:');
    expect(tid(wrapper, 'task-row-t-a')).toContain('A better');
    expect(tid(wrapper, 'task-row-t-b')).toContain('B better');
    expect(tid(wrapper, 'task-row-t-n')).toContain('noise');
    expect(tid(wrapper, 'task-row-t-i')).toContain('insufficient data');
    expect(tid(wrapper, 'task-row-t-x')).toContain('payload inconsistent');
    expect(tid(wrapper, 'task-row-t-x')).not.toMatch(/\bnoise\b/);
  });
});

describe('CompareView category reasons', () => {
  it('shows the API reason on a noise block and on a better block, verbatim', async () => {
    const { wrapper } = await mountView({
      payload: makeCompare({
        by_category: {
          memory_dependent: category({ delta: 0.4, ci_low: 0.2, ci_high: 0.6, verdict: 'A_better', reason: 'reason text for the better block' }),
          memory_distractor: null,
          neutral: category({ delta: 0.1, ci_low: -0.1, ci_high: 0.3, verdict: 'noise', reason: 'reason text for the noise block' }),
          honesty: null,
        },
      }),
    });
    expect(tid(wrapper, 'category-memory_dependent')).toContain('reason text for the better block');
    expect(tid(wrapper, 'category-neutral')).toContain('reason text for the noise block');
  });
});

describe('CompareView layout and content', () => {
  it('puts the reliability, judge policy and rate-limit badges before the aggregate card', async () => {
    const { wrapper } = await mountView({ payload: makeCompare({ rate_limit_affected_trials: 3 }) });
    const agg = wrapper.get('[data-testid="aggregate"]').element;
    for (const id of ['badge-reliability', 'badge-judge-policy', 'badge-rate-limit']) {
      expect(follows(wrapper.get(`[data-testid="${id}"]`).element, agg), id).toBe(true);
    }
    expect(tid(wrapper, 'badge-rate-limit')).toBe('rate-limit affected trials: 3');
    expect(wrapper.get('[data-testid="badge-rate-limit"]').classes()).toContain('badge-warn');
    // the axis line sits between the badges and the aggregate, and the categories come after the aggregate
    expect(follows(wrapper.get('[data-testid="badges"]').element, wrapper.get('[data-testid="axis"]').element)).toBe(true);
    expect(follows(wrapper.get('[data-testid="axis"]').element, agg)).toBe(true);
    expect(follows(agg, wrapper.get('[data-testid="categories"]').element)).toBe(true);
    expect(follows(wrapper.get('[data-testid="categories"]').element, wrapper.get('[data-testid="sign-test"]').element)).toBe(true);
    expect(follows(wrapper.get('[data-testid="sign-test"]').element, wrapper.get('[data-testid="per-task-table"]').element)).toBe(true);
    expect(follows(wrapper.get('[data-testid="per-task-table"]').element, wrapper.get('[data-testid="metrics-table"]').element)).toBe(true);
    expect(follows(wrapper.get('[data-testid="metrics-table"]').element, wrapper.get('[data-testid="chart-delta"]').element)).toBe(true);
    expect(follows(wrapper.get('[data-testid="chart-delta"]').element, wrapper.get('[data-testid="csv-link"]').element)).toBe(true);
  });

  it('shows a neutral rate-limit badge with the count 0 and good badges for complete and trusted', async () => {
    const { wrapper } = await mountView();
    expect(tid(wrapper, 'badge-rate-limit')).toBe('rate-limit affected trials: 0');
    expect(wrapper.get('[data-testid="badge-rate-limit"]').classes()).not.toContain('badge-warn');
    expect(tid(wrapper, 'badge-reliability')).toBe('reliability: complete');
    expect(wrapper.get('[data-testid="badge-reliability"]').classes()).toContain('badge-good');
    expect(wrapper.get('[data-testid="badge-judge-policy"]').classes()).toContain('badge-good');
    expect(wrapper.find('[data-testid="badge-judge-confidence"]').exists()).toBe(false);
  });

  it('shows partial reliability with the unfinished and excluded counts', async () => {
    const { wrapper } = await mountView({ payload: makeCompare({ reliability: 'partial', n_unfinished: 5, n_excluded: 2 }) });
    expect(tid(wrapper, 'badge-reliability')).toBe('reliability: partial (5 unfinished, 2 excluded)');
    expect(wrapper.get('[data-testid="badge-reliability"]').classes()).toContain('badge-warn');
  });

  it('shows the flagged policy, the low confidence badge and the excluded task names', async () => {
    const { wrapper } = await mountView({
      payload: makeCompare({ judge_policy_applied: 'flagged', judge_confidence: 'low', judge_excluded_tasks: ['jdg-01', 'jdg-02'] }),
    });
    expect(wrapper.get('[data-testid="badge-judge-policy"]').classes()).toContain('badge-warn');
    expect(tid(wrapper, 'badge-judge-confidence')).toBe('judge confidence: low');
    expect(tid(wrapper, 'judge-excluded-tasks')).toContain('jdg-01, jdg-02');
  });

  it('shows the excluded policy as a bad badge', async () => {
    const { wrapper } = await mountView({ payload: makeCompare({ judge_policy_applied: 'excluded' }) });
    expect(wrapper.get('[data-testid="badge-judge-policy"]').classes()).toContain('badge-bad');
    expect(tid(wrapper, 'badge-judge-policy')).toBe('judge policy: excluded');
  });

  it('prints the counts, ci_method and stats_version, and lists unpaired tasks with their reasons', async () => {
    const { wrapper } = await mountView({
      payload: makeCompare({ n_tasks: 7, n_trials_per_task: 3, n_scored: 40, n_excluded: 2, n_unfinished: 1, unpaired_tasks: [{ task_id: 'only-in-a', reason: 'no finished trial for B' }] }),
    });
    const counts = tid(wrapper, 'counts');
    for (const part of ['n_tasks 7', 'n_trials_per_task 3', 'n_scored 40', 'n_excluded 2', 'n_unfinished 1', 'ci_method percentile', 'stats_version 1.0.0']) {
      expect(counts).toContain(part);
    }
    expect(tid(wrapper, 'unpaired')).toContain('only-in-a');
    expect(tid(wrapper, 'unpaired')).toContain('no finished trial for B');
  });

  it('shows the heading with both config names and a link back to the experiment', async () => {
    const { wrapper } = await mountView();
    expect(tid(wrapper, 'heading')).toBe('Compare: config alpha (A) vs config beta (B)');
    expect(wrapper.get('[data-testid="back-link"]').attributes('href')).toBe(`/experiments/${EXP}`);
  });

  it('shows the aggregate card with both pass rates, the interval, min detectable and its caption, resamples and seed', async () => {
    const { wrapper } = await mountView({ payload: realP3Payload });
    const card = tid(wrapper, 'aggregate');
    expect(card).toContain('A: hermes memory off pass rate 0.667');
    expect(card).toContain('B: hermes memory seeded pass rate 1.000');
    expect(card).toContain('delta (A - B) -0.333 [-1.000, 0.000]');
    expect(card).toContain('min detectable: 0.500');
    expect(card).toContain('the smallest effect this experiment could have detected');
    expect(card).toContain('resamples 10000, seed 20260101');
  });

  it('shows both bounds of every interval, including the real fixture "-0.333 [-1.000, 0.000]"', async () => {
    const { wrapper } = await mountView({ payload: realP3Payload });
    const intervals = wrapper.findAll('.interval').map((n) => n.text());
    expect(intervals).toContain('-0.333 [-1.000, 0.000]');
    // every rendered interval prints 2 bounds inside brackets
    expect(intervals.length).toBeGreaterThan(8);
    for (const t of intervals) expect(t).toMatch(/^\S+ \[\S+, \S+\]$/);
    // the interval of the aggregate shows up in the aggregate card and in the pass-rate row of the table
    expect(tid(wrapper, 'aggregate')).toContain('-0.333 [-1.000, 0.000]');
    expect(tid(wrapper, 'metric-pass-rate')).toContain('-0.333 [-1.000, 0.000]');
    // a category whose interval is missing prints n/a for both bounds
    expect(tid(wrapper, 'category-memory_dependent')).toContain('-1.000 [n/a, n/a]');
  });

  it('shows the 4 category cards and a message for a null category', async () => {
    const { wrapper } = await mountView({ payload: realP3Payload });
    expect(wrapper.findAll('[data-testid^="category-"]').length).toBe(4);
    expect(tid(wrapper, 'category-memory_distractor')).toContain('no tasks of this category in this experiment');
    const dependent = tid(wrapper, 'category-memory_dependent');
    expect(dependent).toContain('n_tasks 1');
    expect(dependent).toContain('pass rate A 0.000, B 1.000');
    expect(dependent).toContain('insufficient data: 1 paired task(s); an interval needs at least 2');
    expect(dependent).not.toContain('better by');
    expect(dependent).not.toContain('noise:');
    expect(tid(wrapper, 'category-neutral')).not.toContain('no tasks of this category');
  });

  it('shows the sign test line', async () => {
    const { wrapper } = await mountView({ payload: realP3Payload });
    expect(tid(wrapper, 'sign-test')).toBe('Sign test: A won on 0 tasks, B won on 1, 2 tied (exact p = 1.000)');
  });

  it('shows the omitted reason when mcnemar is null and the counts when it is present', async () => {
    const omitted = await mountView({ payload: realP3Payload });
    expect(tid(omitted.wrapper, 'mcnemar')).toBe(`McNemar not computed: ${realP3Payload.mcnemar_omitted}`);
    omitted.wrapper.unmount();
    vi.restoreAllMocks();

    const present = await mountView({
      payload: makeCompare({ mcnemar: { a_only: 4, b_only: 1, both_pass: 5, both_fail: 2, n_pairs: 12, n_discordant: 5, p_value: 0.375 }, mcnemar_omitted: null }),
    });
    const line = tid(present.wrapper, 'mcnemar');
    expect(line).toContain('a_only 4');
    expect(line).toContain('b_only 1');
    expect(line).toContain('n_discordant 5');
    expect(line).toContain('p_value 0.375');
    expect(line).not.toContain('not computed');
  });

  it('puts the "direction only" caption directly above the per-task table', async () => {
    const { wrapper } = await mountView({ payload: realP3Payload });
    const caption = wrapper.get('[data-testid="direction-caption"]');
    expect(caption.text().replace(/\s+/g, ' ')).toBe(
      'direction only: per-task intervals resample the N trials of a single task and no multiple-comparison correction is applied',
    );
    expect(caption.element.nextElementSibling).toBe(wrapper.get('[data-testid="per-task-table"]').element);
  });

  it('lists the per-task rows with rates, delta interval and verdict word', async () => {
    const { wrapper } = await mountView({ payload: realP3Payload });
    const row = tid(wrapper, 'task-row-mem-01-staging-db');
    expect(row).toContain('memory_dependent');
    expect(row).toContain('0.000');
    expect(row).toContain('1.000');
    expect(row).toContain('-1.000 [-1.000, -1.000]');
    expect(row).toContain('B better');
    expect(wrapper.findAll('[data-testid="per-task-table"] tbody tr').length).toBe(3);
  });

  it('shows judge-excluded rows only in the separate excluded table', async () => {
    const rows: PerTaskRow[] = [
      perTask({ task_id: 'det-in', verdict: 'noise' }),
      perTask({ task_id: 'jdg-out', category: 'neutral_judged', judge_excluded: true, delta: 0.5, ci_low: 0.2, ci_high: 0.8, verdict: 'A_better' }),
    ];
    const { wrapper } = await mountView({ payload: makeCompare({ per_task: rows, judge_policy_applied: 'excluded', judge_excluded_tasks: ['jdg-out'] }) });
    const main = tid(wrapper, 'per-task-table');
    const excluded = tid(wrapper, 'excluded-table');
    expect(main).toContain('det-in');
    expect(main).not.toContain('jdg-out');
    expect(excluded).toContain('jdg-out');
    expect(excluded).not.toContain('det-in');
    expect(text(wrapper)).toContain('Excluded by the judge policy (not in any headline figure)');
  });

  it('has no excluded table or title when no row is judge-excluded', async () => {
    const { wrapper } = await mountView({ payload: realP3Payload });
    expect(wrapper.find('[data-testid="excluded-table"]').exists()).toBe(false);
    expect(text(wrapper)).not.toContain('Excluded by the judge policy');
  });

  it('shows quality, cost, latency and tokens side by side with intervals and the A - B interval', async () => {
    const { wrapper } = await mountView({ payload: realP3Payload });
    const pass = tid(wrapper, 'metric-pass-rate');
    expect(pass).toContain('0.667');
    expect(pass).toContain('1.000');
    const cost = tid(wrapper, 'metric-cost');
    expect(cost).toContain('0.000597 [0.000162, 0.001426]');
    expect(cost).toContain('0.000172 [0.000109, 0.000203]');
    expect(cost).toContain('[-0.000041, 0.001317]');
    expect(tid(wrapper, 'metric-latency')).toContain('[821.0, 25655.0]');
    expect(tid(wrapper, 'metric-input-tokens')).toContain('[-2268.0, 69118.5]');
    expect(tid(wrapper, 'metric-output-tokens')).toContain('375.2 [77.0, 952.5]');
    // the pass-rate means have no interval of their own: no [..] directly after them
    expect(wrapper.get('[data-testid="metric-pass-rate"] td:nth-child(2)').text()).toBe('0.667');
    expect(wrapper.get('[data-testid="metric-pass-rate"] td:nth-child(3)').text()).toBe('1.000');
  });

  it('prints n/a for a missing delta_ci instead of an interval', async () => {
    const { wrapper } = await mountView({ payload: makeCompare({ cost: { a: { mean: null, ci_low: null, ci_high: null }, b: { mean: 0.1, ci_low: 0.05, ci_high: 0.2 }, delta_ci: null } }) });
    const cost = tid(wrapper, 'metric-cost');
    expect(cost).toContain('n/a [n/a, n/a]');
    expect(cost.endsWith('n/a')).toBe(true);
  });

  it('draws 1 delta chart and 1 svg per config, each with role img, an aria-label and a title', async () => {
    const { wrapper } = await mountView({ payload: realP3Payload });
    for (const id of ['chart-delta', 'chart-a', 'chart-b']) {
      const svg = wrapper.get(`[data-testid="${id}"]`);
      expect(svg.element.tagName.toLowerCase()).toBe('svg');
      expect(svg.attributes('role')).toBe('img');
      expect(svg.attributes('aria-label')).toBeTruthy();
      expect(svg.find('title').exists()).toBe(true);
    }
    expect(wrapper.get('[data-testid="chart-a"]').attributes('aria-label')).toContain('hermes memory off');
    expect(wrapper.get('[data-testid="chart-b"]').attributes('aria-label')).toContain('hermes memory seeded');
    expect(wrapper.get('[data-testid="chart-delta"]').attributes('aria-label')).toContain('-0.333');
  });

  it('draws the pass-rate bar without a whisker and the cost bar with one', async () => {
    const { wrapper } = await mountView({ payload: realP3Payload });
    for (const id of ['chart-a', 'chart-b']) {
      const chart = wrapper.get(`[data-testid="${id}"]`);
      expect(chart.find('[data-testid="bar-pass-rate"]').exists(), `${id} pass bar`).toBe(true);
      expect(chart.find('[data-testid="whisker-pass-rate"]').exists(), `${id} pass whisker`).toBe(false);
      expect(chart.find('[data-testid="no-interval-note"]').text()).toBe('no interval in payload');
      for (const key of ['cost', 'latency', 'input-tokens', 'output-tokens']) {
        expect(chart.find(`[data-testid="bar-${key}"]`).exists(), `${id} ${key} bar`).toBe(true);
        expect(chart.find(`[data-testid="whisker-${key}"]`).exists(), `${id} ${key} whisker`).toBe(true);
      }
    }
  });

  it('scales the pass-rate bar by the rate and puts A and B on the same scale per metric', async () => {
    const { wrapper } = await mountView({ payload: realP3Payload });
    const width = (chart: string, key: string): number => Number(wrapper.get(`[data-testid="${chart}"] [data-testid="bar-${key}"]`).attributes('width'));
    // p_a 0.667 and p_b 1 on a 0..1 scale: the ratio of the bars is 2 to 3
    expect(width('chart-a', 'pass-rate') / width('chart-b', 'pass-rate')).toBeCloseTo(0.6667, 3);
    // cost mean A 0.000597 against B 0.000172 on the larger ci_high (0.001426): the ratio of the bars is the ratio of the means
    expect(width('chart-a', 'cost') / width('chart-b', 'cost')).toBeCloseTo(0.000597 / 0.00017166666666666667, 3);
    // the whisker of A cost ends at the full scale width because 0.001426 is the shared maximum
    const whisker = wrapper.findAll('[data-testid="chart-a"] [data-testid="whisker-cost"] line');
    const xs = whisker.flatMap((l) => [Number(l.attributes('x1')), Number(l.attributes('x2'))]);
    const bar = wrapper.get('[data-testid="chart-a"] [data-testid="bar-cost"]');
    expect(Math.max(...xs)).toBeCloseTo(Number(bar.attributes('x')) + 270, 3);
  });

  it('puts A and B on the shared scale when B has the larger maximum', async () => {
    const { wrapper } = await mountView({
      payload: makeCompare({ cost: { a: { mean: 100, ci_low: 50, ci_high: 200 }, b: { mean: 300, ci_low: 200, ci_high: 400 }, delta_ci: [-300, -100] } }),
    });
    const attr = (chart: string, key: string, name: string): number => Number(wrapper.get(`[data-testid="${chart}"] [data-testid="bar-${key}"]`).attributes(name));
    // the scale is B's maximum 400 (not A's 200): A mean 100 is 1/4 of 270, B mean 300 is 3/4 of 270
    expect(attr('chart-a', 'cost', 'width')).toBeCloseTo(67.5, 3);
    expect(attr('chart-b', 'cost', 'width')).toBeCloseTo(202.5, 3);
    const xs = wrapper.findAll('[data-testid="chart-a"] [data-testid="whisker-cost"] line').flatMap((l) => [Number(l.attributes('x1')), Number(l.attributes('x2'))]);
    expect(Math.max(...xs)).toBeCloseTo(attr('chart-a', 'cost', 'x') + 135, 3);
  });

  it('keeps the mean visible and marks the interval n/a when only the interval is null', async () => {
    const { wrapper } = await mountView({
      payload: makeCompare({ latency_ms: { a: { mean: 100, ci_low: null, ci_high: null }, b: { mean: 200, ci_low: 150, ci_high: 250 }, delta_ci: null } }),
    });
    const a = wrapper.get('[data-testid="chart-a"] [data-testid="row-latency"]').text();
    expect(a).toContain('100.0');
    expect(a).toContain('interval n/a');
    expect(wrapper.find('[data-testid="chart-a"] [data-testid="bar-latency"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="chart-a"] [data-testid="whisker-latency"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="chart-b"] [data-testid="row-latency"]').text()).toContain('200.0 [150.0, 250.0]');
  });

  it('skips a bar and prints n/a when the mean or the interval is null', async () => {
    const { wrapper } = await mountView({
      payload: makeCompare({ latency_ms: { a: { mean: 100, ci_low: null, ci_high: null }, b: { mean: null, ci_low: null, ci_high: null }, delta_ci: null } }),
    });
    for (const id of ['chart-a', 'chart-b']) {
      const chart = wrapper.get(`[data-testid="${id}"]`);
      expect(chart.find('[data-testid="bar-latency"]').exists(), id).toBe(false);
      expect(chart.get('[data-testid="row-latency"]').text()).toContain('n/a');
      expect(chart.find('[data-testid="bar-cost"]').exists(), id).toBe(true);
    }
  });

  it('draws the delta whisker and dot, and omits the whisker when the interval is missing', async () => {
    const full = await mountView({ payload: realP3Payload });
    expect(full.wrapper.find('[data-testid="chart-delta"] [data-testid="delta-whisker"]').exists()).toBe(true);
    expect(full.wrapper.find('[data-testid="chart-delta"] [data-testid="delta-dot"]').exists()).toBe(true);
    expect(full.wrapper.find('[data-testid="chart-delta"] [data-testid="zero-line"]').exists()).toBe(true);
    expect(full.wrapper.get('[data-testid="chart-delta"]').text()).toContain('delta (A - B) -0.333 [-1.000, 0.000]');
    full.wrapper.unmount();
    vi.restoreAllMocks();

    const cut = await mountView({ payload: isolated({ ci_low: null, ci_high: null, verdict: 'insufficient_data' }) });
    expect(cut.wrapper.find('[data-testid="chart-delta"] [data-testid="delta-whisker"]').exists()).toBe(false);
    expect(cut.wrapper.find('[data-testid="chart-delta"] [data-testid="delta-dot"]').exists()).toBe(true);
  });

  it('puts the delta dot left of the zero line for a negative delta and right of it for a positive one', async () => {
    const neg = await mountView({ payload: realP3Payload });
    const zeroX = Number(neg.wrapper.get('[data-testid="zero-line"]').attributes('x1'));
    expect(Number(neg.wrapper.get('[data-testid="delta-dot"]').attributes('cx'))).toBeLessThan(zeroX);
    neg.wrapper.unmount();
    vi.restoreAllMocks();
    const pos = await mountView({ payload: isolated({ delta: 0.25, ci_low: 0.1, ci_high: 0.4, verdict: 'A_better' }) });
    expect(Number(pos.wrapper.get('[data-testid="delta-dot"]').attributes('cx'))).toBeGreaterThan(zeroX);
  });

  it('links compare.csv with both config ids and prints the comparison run id', async () => {
    const { wrapper } = await mountView({ payload: realP3Payload });
    const href = wrapper.get('[data-testid="csv-link"]').attributes('href') ?? '';
    expect(href).toContain(`/experiments/${encodeURIComponent(EXP)}/compare.csv`);
    expect(href).toContain(`a=${realP3Payload.config_a.id}`);
    expect(href).toContain(`b=${realP3Payload.config_b.id}`);
    expect(tid(wrapper, 'run-id')).toBe('comparison_run_id 01M5Q8A3MGSM0TWT0RH6WJQPEJ');
  });

  it('omits the run id when the payload has none', async () => {
    const { wrapper } = await mountView();
    expect(wrapper.find('[data-testid="run-id"]').exists()).toBe(false);
  });

  it('notes an experiment with no scored trials', async () => {
    const { wrapper } = await mountView({ payload: makeCompare({ n_scored: 0, n_tasks: 0, per_task: [], aggregate: aggregate({ p_a: null, p_b: null, delta: null, ci_low: null, ci_high: null, min_detectable: null, verdict: 'insufficient_data' }) }) });
    expect(tid(wrapper, 'empty')).toContain('No scored trials');
    expect(tid(wrapper, 'verdict-aggregate')).toMatch(/^insufficient data:/);
  });
});

describe('CompareView axis', () => {
  it('shows the payload axis and the config diff from the stored configs', async () => {
    const { wrapper } = await mountView();
    expect(tid(wrapper, 'axis-label')).toBe('memory off vs seeded');
    expect(tid(wrapper, 'axis-diff')).toBe('differs in settings only (memory.fixture, memory.fixture_hash, memory.mode)');
  });

  it('says "axis not stated" for a null axis', async () => {
    const { wrapper } = await mountView({ payload: makeCompare({ axis: null }) });
    expect(tid(wrapper, 'axis-label')).toBe('axis not stated');
  });

  it('says multiple axes differ when harness and model both differ', async () => {
    const { wrapper } = await mountView({
      configs: [memoryOff(), makeConfig({ id: B_ID, name: 'config beta', harness_id: 'minimal_loop', model_id: 'model-c' })],
    });
    expect(tid(wrapper, 'axis-diff')).toBe('multiple axes differ: not attributable');
  });

  it('shows an error, not a silent gap, when the config diff cannot be loaded', async () => {
    const { wrapper } = await mountView({ configsError: new ApiError(500, 'configs are down', ['db timeout'], null) });
    const err = tid(wrapper, 'api-error');
    expect(err).toContain('Config diff unavailable');
    expect(err).toContain('configs are down');
    expect(err).toContain('db timeout');
    expect(wrapper.find('[data-testid="axis-diff"]').exists()).toBe(false);
    // the comparison itself is still shown
    expect(wrapper.find('[data-testid="aggregate"]').exists()).toBe(true);
  });

  it('reloads the configs once when the cached list lacks a config of the comparison', async () => {
    const { wrapper } = await mountView({ configs: [memoryOff()] });
    expect(tid(wrapper, 'api-error')).toContain('does not list both configs');
    expect(api.listConfigs).toHaveBeenCalledTimes(2);
  });
});

describe('CompareView pickers, query and errors', () => {
  it('forwards the a and b query to the API and keeps them in the pickers', async () => {
    const { wrapper } = await mountView({ query: `?a=${B_ID}&b=${A_ID}`, payload: makeCompare({ config_a: { id: B_ID, name: 'config beta' }, config_b: { id: A_ID, name: 'config alpha' } }) });
    expect(api.compare).toHaveBeenCalledWith(EXP, B_ID, A_ID);
    expect((wrapper.get('[data-testid="pick-a"]').element as HTMLSelectElement).value).toBe(B_ID);
    expect((wrapper.get('[data-testid="pick-b"]').element as HTMLSelectElement).value).toBe(A_ID);
    expect(wrapper.get('[data-testid="compare-link"]').attributes('href')).toBe(`/experiments/${EXP}/compare?a=${B_ID}&b=${A_ID}`);
  });

  it('calls the API without a and b when the route has no query (2 configs: the API picks the pair)', async () => {
    const { wrapper } = await mountView();
    expect(api.compare).toHaveBeenCalledWith(EXP, undefined, undefined);
    expect((wrapper.get('[data-testid="pick-a"]').element as HTMLSelectElement).value).toBe(A_ID);
    expect((wrapper.get('[data-testid="pick-b"]').element as HTMLSelectElement).value).toBe(B_ID);
    expect(wrapper.findAll('[data-testid="pick-a"] option').length).toBe(2);
  });

  it('builds the Compare link from the picked configs and reloads when the query changes', async () => {
    const { wrapper, router } = await mountView();
    await wrapper.get('[data-testid="pick-a"]').setValue(B_ID);
    await wrapper.get('[data-testid="pick-b"]').setValue(A_ID);
    const link = wrapper.get('[data-testid="compare-link"]');
    expect(link.attributes('href')).toBe(`/experiments/${EXP}/compare?a=${B_ID}&b=${A_ID}`);
    expect(link.text()).toBe('Compare');
    await link.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ a: B_ID, b: A_ID });
    expect(api.compare).toHaveBeenLastCalledWith(EXP, B_ID, A_ID);
    expect(api.compare).toHaveBeenCalledTimes(2);
  });

  it('with 3 configs and no a and b, shows the API 400 with its reasons and keeps the pickers', async () => {
    const three = makeExperiment({}, [
      { id: A_ID, name: 'config alpha' },
      { id: B_ID, name: 'config beta' },
      { id: '01CONFIGC00000000000000000C', name: 'config gamma' },
    ]);
    const { wrapper } = await mountView({
      experiment: three,
      compareError: new ApiError(400, 'this experiment has 3 configs; pass both a and b', ['a and b are config ids of this experiment'], null),
    });
    const err = tid(wrapper, 'api-error');
    expect(err).toContain('this experiment has 3 configs; pass both a and b');
    expect(err).toContain('a and b are config ids of this experiment');
    expect(wrapper.get('[data-testid="api-error"]').classes()).toContain('error');
    expect(wrapper.findAll('[data-testid="pick-a"] option').map((o) => o.text())).toEqual(['config alpha', 'config beta', 'config gamma']);
    expect(wrapper.findAll('[data-testid="pick-b"] option').length).toBe(3);
    expect(wrapper.find('[data-testid="compare-link"]').exists()).toBe(true);
    // no numbers from a comparison that was never computed
    expect(wrapper.find('[data-testid="aggregate"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="badges"]').exists()).toBe(false);
    // choosing a pair then points the link at it
    await wrapper.get('[data-testid="pick-a"]').setValue('01CONFIGC00000000000000000C');
    expect(wrapper.get('[data-testid="compare-link"]').attributes('href')).toContain('a=01CONFIGC00000000000000000C');
  });

  it('shows an error and no pickers when the experiment cannot be loaded', async () => {
    const { wrapper } = await mountView({
      experimentError: new ApiError(404, 'experiment not found', [], null),
      compareError: new ApiError(404, 'experiment not found', [], null),
    });
    const errs = wrapper.findAll('[data-testid="api-error"]').map((e) => e.text());
    expect(errs.length).toBe(2);
    expect(errs[0]).toContain('Could not load the experiment');
    expect(errs[0]).toContain('experiment not found');
    expect(wrapper.find('[data-testid="pickers"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(false);
  });

  it('shows a plain Error message when the failure is not an ApiError', async () => {
    const { wrapper } = await mountView({ compareError: new Error('boom') });
    expect(tid(wrapper, 'api-error')).toContain('boom');
  });

  it('says there is nothing to compare for an experiment with fewer than 2 configs', async () => {
    const { wrapper } = await mountView({
      experiment: makeExperiment({}, [{ id: A_ID, name: 'config alpha' }]),
      compareError: new ApiError(400, 'an experiment needs 2 configs to compare', [], null),
    });
    expect(tid(wrapper, 'few-configs')).toContain('fewer than 2 configs');
    expect(tid(wrapper, 'api-error')).toContain('an experiment needs 2 configs to compare');
  });

  it('shows a loading text before the comparison arrives', async () => {
    let release: (p: ComparePayload) => void = () => undefined;
    vi.spyOn(api, 'getExperiment').mockResolvedValue(makeExperiment());
    vi.spyOn(api, 'compare').mockImplementation(() => new Promise<ComparePayload>((r) => (release = r)));
    vi.spyOn(api, 'listConfigs').mockResolvedValue([memoryOff(), memorySeeded()]);
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push(`/experiments/${EXP}/compare`);
    await router.isReady();
    const wrapper = mount(CompareView, { props: { id: EXP }, global: { plugins: [createPinia(), router] } });
    await flushPromises();
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="aggregate"]').exists()).toBe(false);
    release(makeCompare());
    await flushPromises();
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="aggregate"]').exists()).toBe(true);
  });

  it('keeps the newer comparison when an older request resolves last', async () => {
    const pending: Array<(p: ComparePayload) => void> = [];
    vi.spyOn(api, 'getExperiment').mockResolvedValue(makeExperiment());
    vi.spyOn(api, 'compare').mockImplementation(() => new Promise<ComparePayload>((r) => pending.push(r)));
    vi.spyOn(api, 'listConfigs').mockResolvedValue([memoryOff(), memorySeeded()]);
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push(`/experiments/${EXP}/compare`);
    await router.isReady();
    const wrapper = mount(CompareView, { props: { id: EXP }, global: { plugins: [createPinia(), router] } });
    await flushPromises();
    await router.push(`/experiments/${EXP}/compare?a=${B_ID}&b=${A_ID}`);
    await flushPromises();
    expect(pending.length).toBe(2);
    pending[1](makeCompare({ config_a: { id: B_ID, name: 'newer alpha' }, config_b: { id: A_ID, name: 'newer beta' } }));
    await flushPromises();
    pending[0](makeCompare({ config_a: { id: A_ID, name: 'older alpha' }, config_b: { id: B_ID, name: 'older beta' } }));
    await flushPromises();
    expect(tid(wrapper, 'heading')).toContain('newer alpha');
    expect(text(wrapper)).not.toContain('older alpha');
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(false);
  });

  it('does not refetch when the route changes but id, a and b stay the same', async () => {
    const { router } = await mountView({ query: `?a=${A_ID}&b=${B_ID}` });
    expect(api.compare).toHaveBeenCalledTimes(1);
    await router.push({ query: { a: A_ID, b: B_ID }, hash: '#top' });
    await flushPromises();
    expect(router.currentRoute.value.hash).toBe('#top');
    expect(api.compare).toHaveBeenCalledTimes(1);
  });

  it('warns when A and B are the same config', async () => {
    const { wrapper } = await mountView();
    await wrapper.get('[data-testid="pick-b"]').setValue(A_ID);
    expect(wrapper.find('[data-testid="same-pick"]').exists()).toBe(true);
  });
});
