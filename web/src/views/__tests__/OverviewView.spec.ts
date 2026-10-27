import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { api, ApiError } from '../../api/client';
import type { SummaryComparison, SummaryConfig, SummaryPayload } from '../../api/types';
import AppShell from '../../components/AppShell.vue';
import { routes } from '../../router';
import OverviewView from '../OverviewView.vue';

function comparison(over: Partial<SummaryComparison> & { comparison_run_id: string }): SummaryComparison {
  return {
    experiment_id: 'E1',
    experiment_name: 'memory off vs seeded',
    axis: 'memory',
    config_a_id: 'CA',
    config_a_name: 'hermes off',
    config_b_id: 'CB',
    config_b_name: 'hermes seeded',
    verdict: 'noise',
    delta: 0.05,
    ci_low: -0.1,
    ci_high: 0.2,
    reliability: 'complete',
    judge_policy_applied: 'excluded',
    stats_version: '1.1.0',
    computed_at: '2026-10-25T15:23:56.457Z',
    ...over,
  };
}

function config(over: Partial<SummaryConfig> & { config_id: string }): SummaryConfig {
  return {
    name: `config ${over.config_id}`,
    harness_id: 'hermes',
    model_id: 'model-b',
    memory_mode: 'off',
    trials_done: 10,
    pass_rate: 0.5,
    mean_cost_usd: 0.002,
    mean_latency_ms: 12000,
    mean_input_tokens: 9000,
    mean_output_tokens: 300,
    ...over,
  };
}

function payload(over: Partial<SummaryPayload> = {}): SummaryPayload {
  return {
    totals: { experiments: 2, configs: 3, tasks_current: 22, trials_done: 264, trials_errored: 4, spend_usd: 1.234567, models: 2, harnesses: 2 },
    latest_comparisons: [comparison({ comparison_run_id: 'R1' })],
    configs: [config({ config_id: 'CA', name: 'hermes off', pass_rate: 0.667 }), config({ config_id: 'CB', name: 'hermes seeded', pass_rate: 0.98, trials_done: 66 })],
    failures: { step_exhaustion: 0, wrong_answer: 5, abstained: 2, judge_criteria_unmet: 9 },
    recent_experiments: [
      {
        id: 'E1',
        name: 'memory off vs seeded',
        status: 'completed',
        n_trials: 3,
        progress: { pending: 0, running: 0, done: 130, errored: 2, cancelled: 0, total: 132 },
        created_at: '2026-10-25T10:00:00.000Z',
      },
    ],
    ...over,
  };
}

let spy: MockInstance<typeof api.summary>;
const wrappers: VueWrapper[] = [];

beforeEach(() => {
  spy = vi.spyOn(api, 'summary').mockResolvedValue(payload());
});

afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  vi.restoreAllMocks();
});

async function mountView(): Promise<VueWrapper> {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/');
  await router.isReady();
  const wrapper = mount(OverviewView, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
  wrappers.push(wrapper);
  return wrapper;
}

const verdictOf = (w: VueWrapper, id: string) => w.find(`[data-testid="verdict-${id}"] [data-testid="verdict-kind"]`);

describe('OverviewView tiles', () => {
  it('renders the totals with their units, fetched once on mount', async () => {
    const w = await mountView();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(w.find('[data-testid="tile-experiments"] .stat-value').text()).toBe('2');
    expect(w.find('[data-testid="tile-experiments"] .tile-sub').text()).toBe('3 configs, 2 models, 2 harnesses');
    expect(w.find('[data-testid="tile-trials"] .stat-value').text()).toBe('264');
    expect(w.find('[data-testid="tile-spend"] .stat-value').text()).toBe('1.23 USD');
    expect(w.find('[data-testid="tile-spend"] .tile-sub').text()).toBe('1.234567 USD over done trials');
    expect(w.find('[data-testid="tile-errored"] .stat-value').text()).toBe('4');
    expect(w.find('[data-testid="tile-tasks"] .stat-value').text()).toBe('22');
    expect(w.find('[data-testid="tile-best"] .stat-value').text()).toBe('0.980');
    expect(w.find('[data-testid="tile-best"] .tile-sub').text()).toBe('hermes seeded');
  });

  it('breaks a tie for the best config by more done trials, then by name', async () => {
    spy.mockResolvedValue(
      payload({
        configs: [
          config({ config_id: 'X', name: 'zeta', pass_rate: 0.8, trials_done: 30 }),
          config({ config_id: 'Y', name: 'alpha', pass_rate: 0.8, trials_done: 20 }),
          config({ config_id: 'Z', name: 'beta', pass_rate: 0.8, trials_done: 30 }),
          config({ config_id: 'N', name: 'none', pass_rate: null, trials_done: 0 }),
        ],
      }),
    );
    const w = await mountView();
    expect(w.find('[data-testid="tile-best"] .tile-sub').text()).toBe('beta');
  });

  it('refetches only when Refresh is pressed', async () => {
    const w = await mountView();
    await w.find('[data-testid="refresh"]').trigger('click');
    await flushPromises();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('OverviewView verdict cards', () => {
  it('shows "noise" only when the interval contains 0', async () => {
    spy.mockResolvedValue(
      payload({
        latest_comparisons: [
          comparison({ comparison_run_id: 'N1', verdict: 'noise', delta: 0.05, ci_low: -0.1, ci_high: 0.2 }),
          comparison({ comparison_run_id: 'N0', verdict: 'noise', delta: 0.1, ci_low: 0, ci_high: 0.2 }),
          comparison({ comparison_run_id: 'NX', verdict: 'noise', delta: 0.15, ci_low: 0.1, ci_high: 0.2 }),
          comparison({ comparison_run_id: 'B1', verdict: 'B_better', delta: -0.314, ci_low: -0.549, ci_high: -0.098 }),
          comparison({ comparison_run_id: 'BX', verdict: 'B_better', delta: -0.1, ci_low: -0.3, ci_high: 0.05 }),
        ],
      }),
    );
    const w = await mountView();
    expect(verdictOf(w, 'N1').text()).toBe('noise');
    expect(verdictOf(w, 'N0').text()).toBe('noise');
    // A stored "noise" whose interval excludes 0 is not shown as noise.
    expect(verdictOf(w, 'NX').attributes('data-kind')).toBe('inconsistent');
    expect(verdictOf(w, 'NX').text()).not.toMatch(/^noise/);
    expect(verdictOf(w, 'B1').text()).toBe('B better');
    expect(w.find('[data-testid="verdict-B1"]').text()).toContain('by 0.314 [0.098, 0.549]');
    // A decided verdict whose interval contains 0 is not shown as a win either.
    expect(verdictOf(w, 'BX').attributes('data-kind')).toBe('inconsistent');
    expect(w.findAll('[data-kind="noise"]')).toHaveLength(2);
  });

  it('shows the pair, delta with its interval, the badges and a link to the Compare page of the pair', async () => {
    spy.mockResolvedValue(payload({ latest_comparisons: [comparison({ comparison_run_id: 'R1', verdict: 'B_better', delta: -0.314, ci_low: -0.549, ci_high: -0.098, reliability: 'partial' })] }));
    const w = await mountView();
    const card = w.find('[data-testid="verdict-R1"]');
    expect(card.text()).toContain('hermes off');
    expect(card.text()).toContain('hermes seeded');
    expect(card.text()).toContain('axis: memory');
    expect(card.find('[data-testid="verdict-interval"]').text()).toBe('-0.314 [-0.549, -0.098]');
    expect(card.find('[data-testid="verdict-reliability"]').text()).toBe('reliability: partial');
    expect(card.find('[data-testid="verdict-judge"]').text()).toBe('judge: excluded');
    expect(card.find('[data-testid="verdict-compare-link"]').attributes('href')).toBe('/experiments/E1/compare?a=CA&b=CB');
  });

  it('says how to store a comparison when there is none', async () => {
    spy.mockResolvedValue(payload({ latest_comparisons: [] }));
    const w = await mountView();
    expect(w.find('[data-testid="no-verdicts"]').text()).toContain('No stored comparison yet.');
    expect(w.find('[data-testid="verdicts"]').exists()).toBe(false);
  });
});

describe('OverviewView charts, failures and recent experiments', () => {
  it('draws 1 bar and 1 point per config with a pass rate, and failures sorted with zeros left out', async () => {
    spy.mockResolvedValue(
      payload({
        configs: [
          config({ config_id: 'CA', pass_rate: 0.667 }),
          config({ config_id: 'CB', pass_rate: 0.98 }),
          config({ config_id: 'CN', pass_rate: null, mean_cost_usd: null, trials_done: 0 }),
        ],
      }),
    );
    const w = await mountView();
    expect(w.findAll('[data-testid="chart-pass-rate"] g[data-testid^="bar-"]').map((g) => g.attributes('data-testid'))).toEqual(['bar-CB', 'bar-CA']);
    expect(w.findAll('[data-testid="chart-scatter"] g[data-testid^="point-"]')).toHaveLength(2);
    expect(w.text()).toContain('1 config(s) with no graded trial are not drawn.');
    expect(w.findAll('[data-testid="failures"] li').map((li) => li.attributes('data-testid'))).toEqual(['failure-judge_criteria_unmet', 'failure-wrong_answer', 'failure-abstained']);
    expect(w.find('[data-testid="failure-total"]').text()).toBe('16 failed trials');
  });

  it('lists recent experiments with a status chip, a progress fraction and a link', async () => {
    const w = await mountView();
    const row = w.find('tr[data-experiment="E1"]');
    expect(row.find('a').attributes('href')).toBe('/experiments/E1');
    expect(row.find('.chip-completed').text()).toBe('completed');
    expect(row.find('[data-testid="progress-fraction"]').text()).toBe('132 / 132');
  });
});

describe('OverviewView empty and error states', () => {
  it('shows the empty state with a "Create a config" button when there are 0 experiments', async () => {
    spy.mockResolvedValue(
      payload({
        totals: { experiments: 0, configs: 0, tasks_current: 22, trials_done: 0, trials_errored: 0, spend_usd: 0, models: 2, harnesses: 0 },
        latest_comparisons: [],
        configs: [],
        failures: {},
        recent_experiments: [],
      }),
    );
    const w = await mountView();
    expect(w.find('[data-testid="empty"]').text()).toContain('No experiments yet.');
    expect(w.find('[data-testid="create-config"]').attributes('href')).toBe('/configs');
    expect(w.find('[data-testid="tiles"]').exists()).toBe(false);
  });

  it('shows the API message when the summary cannot be loaded', async () => {
    spy.mockRejectedValue(new ApiError(500, 'database down', ['reason 1'], null));
    const w = await mountView();
    expect(w.find('[data-testid="api-error"]').text()).toContain('database down');
    expect(w.find('[data-testid="api-error"]').text()).toContain('reason 1');
  });
});

describe('routing and nav (P8)', () => {
  it('serves the Overview at /, links the wordmark to it, and lists Overview, Configs, Experiments in that order', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('overview');
    const shell = mount(AppShell, { global: { plugins: [createPinia(), router] } });
    wrappers.push(shell);
    expect(shell.findAll('.nav-link').map((a) => [a.text(), a.attributes('href')])).toEqual([
      ['Overview', '/'],
      ['Configs', '/configs'],
      ['Experiments', '/experiments'],
    ]);
    expect(shell.find('.wordmark').attributes('href')).toBe('/');
    expect(router.resolve('/configs').name).toBe('configs');
  });
});
