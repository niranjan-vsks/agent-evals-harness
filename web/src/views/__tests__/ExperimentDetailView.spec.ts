import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { api, ApiError } from '../../api/client';
import type { ExperimentDetail, ExperimentStatus, PilotPayload, TrialRow } from '../../api/types';
import { routes } from '../../router';
import ExperimentDetailView from '../ExperimentDetailView.vue';

const ID = 'EXP1';

function exp(over: Partial<ExperimentDetail> = {}): ExperimentDetail {
  return {
    id: ID,
    name: 'memory walk',
    status: 'completed',
    n_trials: 2,
    seed: 20260101,
    phase: 'full',
    axis: 'hermes memory off vs seeded',
    hypothesis: 'H1: on memory_dependent tasks the seeded config passes more often.',
    worker_manifest: {},
    created_at: '2026-10-24T22:18:30.192Z',
    started_at: '2026-10-24T22:18:31.000Z',
    finished_at: '2026-10-24T22:21:11.239Z',
    pause_reason: null,
    paused: false,
    progress: { pending: 0, running: 0, done: 8, errored: 0, cancelled: 0, total: 8 },
    configs: [
      { id: 'CFG-A', name: 'hermes memory off', position: 0, harness_id: 'hermes', model_slug: 'm' },
      { id: 'CFG-B', name: 'hermes memory seeded', position: 1, harness_id: 'hermes', model_slug: 'm' },
    ],
    tasks: [
      { task_id: 'det-06-ini', task_version_hash: 'bdee9c79e3772010e4c8bcee8880f40de4c1496eeca4b98511a444e1bae9d649', category: 'neutral_deterministic' },
      { task_id: 'mem-01-staging-db', task_version_hash: 'b8a97dacfabe133173325fa4260a4987c235aa2006406d051eece0e79522221d', category: 'memory_dependent' },
    ],
    ...over,
  };
}

function trial(over: Partial<TrialRow> & { id: string }): TrialRow {
  return {
    experiment_id: ID,
    config_id: 'CFG-A',
    task_id: 'det-06-ini',
    task_version_hash: 'h',
    trial_index: 0,
    seed: 1,
    status: 'done',
    attempt_count: 1,
    passed: true,
    exit_reason: 'completed',
    steps: 2,
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
    api_calls: 2,
    latency_ms: 15824,
    cost_usd: 0.000161,
    harness_cost_usd: null,
    price_snapshot: null,
    rate_limit_events: 0,
    error_class: null,
    error_message: null,
    started_at: null,
    ended_at: null,
    ...over,
  };
}

// 6 trials: 2 configs x 2 tasks (+ 2 extra), a mix of passed, failed and unfinished.
const TRIALS: TrialRow[] = [
  trial({ id: 'T1', config_id: 'CFG-A', task_id: 'det-06-ini', trial_index: 0, passed: true }),
  trial({ id: 'T2', config_id: 'CFG-A', task_id: 'mem-01-staging-db', trial_index: 0, passed: false, exit_reason: 'max_steps', steps: 30, rate_limit_events: 2 }),
  trial({ id: 'T3', config_id: 'CFG-A', task_id: 'mem-01-staging-db', trial_index: 1, status: 'errored', passed: null, exit_reason: null, steps: null, cost_usd: null, latency_ms: null, error_class: 'provider_error' }),
  trial({ id: 'T4', config_id: 'CFG-B', task_id: 'det-06-ini', trial_index: 0, passed: true }),
  trial({ id: 'T5', config_id: 'CFG-B', task_id: 'mem-01-staging-db', trial_index: 0, passed: true }),
  trial({ id: 'T6', config_id: 'CFG-B', task_id: 'mem-01-staging-db', trial_index: 1, status: 'running', passed: null, exit_reason: null, steps: null, cost_usd: null, latency_ms: null }),
];

const PILOT_READY: PilotPayload = {
  experiment_id: ID,
  ready: true,
  recommendation_reason: 'The smallest N whose projected half-width is at most the target.',
  n_pilot: 2,
  n_tasks: 3,
  n_judged_tasks: 0,
  n_configs: 2,
  n_cells_used: 6,
  within_task_variance: 0.125,
  bernoulli_bound_variance: 0.25,
  target_half_width: 0.15,
  n_cap: 8,
  projections: [
    { n: 2, half_width_observed: 0.1, half_width_observed_without_judged: 0.2, half_width_bound: 0.5658032638058332, trials_total: 12 },
    { n: 5, half_width_observed: 0.0123, half_width_observed_without_judged: 0.03, half_width_bound: 0.3578454042367085, trials_total: 30 },
  ],
  recommended_n: 5,
  capped: false,
  stats_version: '1.0.0',
};

const PILOT_NOT_READY: PilotPayload = {
  experiment_id: ID,
  ready: false,
  reason: 'no finished trials yet: run at least 1 trial per cell',
  n_pilot: 0,
  n_tasks: 3,
  n_judged_tasks: 0,
  n_configs: 2,
  n_cells_used: 0,
  within_task_variance: null,
  bernoulli_bound_variance: 0.25,
  target_half_width: 0.15,
  n_cap: 8,
  projections: [],
  recommended_n: null,
  capped: false,
  stats_version: '1.0.0',
};

/** dt text -> dd text of the definition lists inside a wrapper. */
function defs(w: VueWrapper | ReturnType<VueWrapper['find']>): Record<string, string> {
  const out: Record<string, string> = {};
  const dts = w.findAll('dt');
  const dds = w.findAll('dd');
  dts.forEach((dt, i) => {
    out[dt.text()] = dds[i].text();
  });
  return out;
}

const BANNED = /delta|verdict|winner|better/i;

let getSpy: MockInstance<typeof api.getExperiment>;
let trialsSpy: MockInstance<typeof api.listTrials>;
let pilotSpy: MockInstance<typeof api.pilot>;
const wrappers: VueWrapper[] = [];

async function mountView(): Promise<{ wrapper: VueWrapper; router: ReturnType<typeof createRouter> }> {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(`/experiments/${ID}`);
  await router.isReady();
  const wrapper = mount(ExperimentDetailView, { props: { id: ID }, global: { plugins: [createPinia(), router] } });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper, router };
}

function withStatus(status: ExperimentStatus, over: Partial<ExperimentDetail> = {}): void {
  getSpy.mockResolvedValue(exp({ status, ...over }));
}

const btn = (w: VueWrapper, name: string) => w.find(`button[data-test="${name}"]`);
const isDisabled = (w: VueWrapper, name: string): boolean => btn(w, name).attributes('disabled') !== undefined;
const rows = (w: VueWrapper) => w.findAll('table.trials tbody tr[data-trial]');
const rowIds = (w: VueWrapper): string[] => rows(w).map((r) => r.attributes('data-trial') ?? '');

beforeEach(() => {
  getSpy = vi.spyOn(api, 'getExperiment').mockResolvedValue(exp());
  trialsSpy = vi.spyOn(api, 'listTrials').mockResolvedValue(TRIALS);
  pilotSpy = vi.spyOn(api, 'pilot').mockResolvedValue(PILOT_READY);
});

afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ExperimentDetailView header', () => {
  it('shows the name, status, hypothesis in its own block, axis, phase, n_trials, seed, dates and the progress counts', async () => {
    withStatus('partial', { progress: { pending: 1, running: 0, done: 5, errored: 1, cancelled: 1, total: 8 } });
    const { wrapper } = await mountView();
    expect(wrapper.find('h1').text()).toContain('memory walk');
    expect(wrapper.find('h1 .chip-partial').text()).toBe('partial');
    expect(wrapper.find('[data-test="hypothesis"]').text()).toContain('H1: on memory_dependent tasks the seeded config passes more often.');
    expect(wrapper.find('[data-test="axis"]').text()).toContain('hermes memory off vs seeded');
    const meta = wrapper.find('dl.meta').text();
    expect(meta).toContain('full');
    expect(meta).toContain('20260101');
    expect(meta).toContain('2026-10-24 22:18:30Z');
    expect(meta).toContain('2026-10-24 22:18:31Z');
    expect(meta).toContain('2026-10-24 22:21:11Z');
    expect(wrapper.find('[data-test="counts"]').text()).toBe('done 5, errored 1, pending 1, running 0, cancelled 1 of 8');
  });

  it('shows the API error inline when the experiment cannot be loaded, not a blank page', async () => {
    getSpy.mockRejectedValue(new ApiError(404, 'experiment EXP1 not found', ['no such id'], null));
    const { wrapper } = await mountView();
    const box = wrapper.find('[data-test="load-error"]');
    expect(box.classes()).toContain('error');
    expect(box.text()).toContain('experiment EXP1 not found');
    expect(box.text()).toContain('no such id');
  });
});

describe('ExperimentDetailView actions', () => {
  it('draft: Start and Cancel enabled, Resume absent', async () => {
    withStatus('draft', { progress: { pending: 8, running: 0, done: 0, errored: 0, cancelled: 0, total: 8 } });
    const { wrapper } = await mountView();
    expect(isDisabled(wrapper, 'start')).toBe(false);
    expect(isDisabled(wrapper, 'cancel')).toBe(false);
    expect(btn(wrapper, 'resume').exists()).toBe(false);
    expect(isDisabled(wrapper, 'reproduce')).toBe(false);
  });

  it('running: Cancel enabled, Start disabled; queued behaves the same', async () => {
    for (const s of ['running', 'queued'] as const) {
      withStatus(s);
      const { wrapper } = await mountView();
      expect(isDisabled(wrapper, 'start')).toBe(true);
      expect(isDisabled(wrapper, 'cancel')).toBe(false);
      expect(btn(wrapper, 'resume').exists()).toBe(false);
      wrapper.unmount();
      wrappers.pop();
    }
  });

  it('completed: Extend enabled, Cancel and Start disabled', async () => {
    withStatus('completed');
    const { wrapper } = await mountView();
    expect(isDisabled(wrapper, 'extend')).toBe(false);
    expect(isDisabled(wrapper, 'cancel')).toBe(true);
    expect(isDisabled(wrapper, 'start')).toBe(true);
  });

  it('cancelled: Extend disabled even with a larger N, Cancel and Start disabled, Reproduce still enabled', async () => {
    withStatus('cancelled');
    const { wrapper } = await mountView();
    expect(isDisabled(wrapper, 'extend')).toBe(true);
    expect(isDisabled(wrapper, 'cancel')).toBe(true);
    expect(isDisabled(wrapper, 'start')).toBe(true);
    expect(isDisabled(wrapper, 'reproduce')).toBe(false);
  });

  it('Extend is prefilled with n_trials + 1 and only enabled for a larger N', async () => {
    withStatus('completed', { n_trials: 4 });
    const { wrapper } = await mountView();
    const input = wrapper.find('#extend-to');
    expect((input.element as HTMLInputElement).value).toBe('5');
    expect(isDisabled(wrapper, 'extend')).toBe(false);
    await input.setValue('4');
    expect(isDisabled(wrapper, 'extend')).toBe(true);
    await input.setValue('');
    expect(isDisabled(wrapper, 'extend')).toBe(true);
    await input.setValue('9');
    expect(isDisabled(wrapper, 'extend')).toBe(false);
  });

  it('Extend calls the API with the number, shows the result and refreshes the experiment and the trials', async () => {
    withStatus('completed', { n_trials: 2 });
    const extendSpy = vi.spyOn(api, 'extendExperiment').mockResolvedValue(exp({ status: 'queued', n_trials: 6 }));
    const { wrapper } = await mountView();
    expect(getSpy).toHaveBeenCalledTimes(1);
    await wrapper.find('#extend-to').setValue('6');
    await btn(wrapper, 'extend').trigger('click');
    await flushPromises();
    expect(extendSpy).toHaveBeenCalledWith(ID, 6);
    expect(typeof extendSpy.mock.calls[0][1]).toBe('number');
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(trialsSpy).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-test="action-result"]').text()).toContain('Extend');
    expect(wrapper.find('[data-test="action-result"]').text()).toContain('queued');
  });

  it('Start calls the API, then reloads the experiment (draft becomes queued)', async () => {
    getSpy.mockResolvedValueOnce(exp({ status: 'draft' })).mockResolvedValue(exp({ status: 'queued' }));
    const startSpy = vi.spyOn(api, 'startExperiment').mockResolvedValue(exp({ status: 'queued' }));
    const { wrapper } = await mountView();
    expect(wrapper.find('h1 .chip-draft').exists()).toBe(true);
    await btn(wrapper, 'start').trigger('click');
    await flushPromises();
    expect(startSpy).toHaveBeenCalledWith(ID);
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(wrapper.find('h1 .chip-queued').exists()).toBe(true);
    expect(isDisabled(wrapper, 'start')).toBe(true);
    expect(wrapper.find('[data-test="action-result"]').text()).toContain('Start');
  });

  it('Cancel calls the API and a refusal is shown inline with its reasons', async () => {
    withStatus('running');
    const cancelSpy = vi.spyOn(api, 'cancelExperiment').mockRejectedValue(new ApiError(409, 'cannot cancel', ['the experiment already finished'], null));
    const { wrapper } = await mountView();
    await btn(wrapper, 'cancel').trigger('click');
    await flushPromises();
    expect(cancelSpy).toHaveBeenCalledWith(ID);
    const box = wrapper.find('[data-test="action-error"]');
    expect(box.classes()).toContain('error');
    expect(box.text()).toContain('cannot cancel');
    expect(box.text()).toContain('the experiment already finished');
  });

  it('Reproduce failure with problems lists each problem inline and stays on the page', async () => {
    const reproSpy = vi
      .spyOn(api, 'reproduceExperiment')
      .mockRejectedValue(new ApiError(409, 'this experiment cannot be reproduced exactly', ['task det-06-ini changed since the run', 'config CFG-B uses a model that was removed'], null));
    const { wrapper, router } = await mountView();
    await btn(wrapper, 'reproduce').trigger('click');
    await flushPromises();
    expect(reproSpy).toHaveBeenCalledWith(ID);
    const box = wrapper.find('[data-test="action-error"]');
    expect(box.text()).toContain('this experiment cannot be reproduced exactly');
    const items = box.findAll('li').map((li) => li.text());
    expect(items).toEqual(['task det-06-ini changed since the run', 'config CFG-B uses a model that was removed']);
    expect(router.currentRoute.value.fullPath).toBe(`/experiments/${ID}`);
  });

  it('Reproduce success opens the new draft', async () => {
    vi.spyOn(api, 'reproduceExperiment').mockResolvedValue(exp({ id: 'DRAFT2', status: 'draft' }));
    const { wrapper, router } = await mountView();
    await btn(wrapper, 'reproduce').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/experiments/DRAFT2');
  });

  it('paused: shows the pause_reason and a Resume button that calls resumeExperiment, then reloads', async () => {
    withStatus('running', { paused: true, pause_reason: 'circuit breaker: 5 provider errors in a row' });
    const resumeSpy = vi.spyOn(api, 'resumeExperiment').mockResolvedValue(exp({ status: 'running' }));
    const { wrapper } = await mountView();
    expect(wrapper.find('h1 .chip-paused').text()).toBe('paused');
    expect(wrapper.find('[data-test="paused"]').text()).toContain('circuit breaker: 5 provider errors in a row');
    await btn(wrapper, 'resume').trigger('click');
    await flushPromises();
    expect(resumeSpy).toHaveBeenCalledWith(ID);
    expect(getSpy).toHaveBeenCalledTimes(2);
  });
});

describe('ExperimentDetailView polling', () => {
  it('follows queued to running to completed every 3000 ms, refreshing the trials each time, then stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    getSpy
      .mockResolvedValueOnce(exp({ status: 'queued' }))
      .mockResolvedValueOnce(exp({ status: 'running' }))
      .mockResolvedValue(exp({ status: 'completed' }));
    const { wrapper } = await mountView();
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(trialsSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2999);
    expect(getSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(trialsSpy).toHaveBeenCalledTimes(2);
    expect(wrapper.find('h1 .chip-running').exists()).toBe(true);

    await vi.advanceTimersByTimeAsync(3000);
    expect(getSpy).toHaveBeenCalledTimes(3);
    expect(trialsSpy).toHaveBeenCalledTimes(3);
    expect(wrapper.find('h1 .chip-completed').exists()).toBe(true);

    await vi.advanceTimersByTimeAsync(30000);
    expect(getSpy).toHaveBeenCalledTimes(3);
    expect(trialsSpy).toHaveBeenCalledTimes(3);
  });

  it('never polls a draft or a terminal experiment', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    withStatus('draft');
    await mountView();
    await vi.advanceTimersByTimeAsync(20000);
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the timer on unmount: no request after the view is gone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    withStatus('running');
    const { wrapper } = await mountView();
    expect(getSpy).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(10000);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(trialsSpy).toHaveBeenCalledTimes(1);
  });

  it('does not stack requests: while a poll is still in flight no further poll starts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release: (v: ExperimentDetail) => void = () => undefined;
    getSpy
      .mockResolvedValueOnce(exp({ status: 'running' }))
      .mockImplementationOnce(() => new Promise<ExperimentDetail>((resolve) => (release = resolve)))
      .mockResolvedValue(exp({ status: 'completed' }));
    await mountView();
    await vi.advanceTimersByTimeAsync(3000);
    expect(getSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(12000);
    expect(getSpy).toHaveBeenCalledTimes(2);
    release(exp({ status: 'running' }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(getSpy).toHaveBeenCalledTimes(3);
  });

  it('a failed poll shows the error and keeps polling while the last known status is running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    getSpy.mockResolvedValueOnce(exp({ status: 'running' })).mockRejectedValueOnce(new ApiError(500, 'boom', [], null)).mockResolvedValue(exp({ status: 'completed' }));
    const { wrapper } = await mountView();
    await vi.advanceTimersByTimeAsync(3000);
    expect(wrapper.find('[data-test="load-error"]').text()).toContain('boom');
    await vi.advanceTimersByTimeAsync(3000);
    expect(getSpy).toHaveBeenCalledTimes(3);
    expect(wrapper.find('[data-test="load-error"]').exists()).toBe(false);
  });
});

describe('ExperimentDetailView trials table', () => {
  it('lists every trial with config name, task and index links, status, PASS/FAIL/-, exit reason, steps, cost, latency, rate limit events and error class', async () => {
    const { wrapper } = await mountView();
    expect(rowIds(wrapper)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
    const heads = wrapper.findAll('table.trials thead th').map((th) => th.text());
    expect(heads).toEqual(['Config', 'Task', 'Index', 'Status', 'Passed', 'Exit reason', 'Steps', 'Cost', 'Latency', 'Rate limit events', 'Error class']);

    const t2 = rows(wrapper)[1].findAll('td').map((td) => td.text());
    expect(t2).toEqual(['hermes memory off', 'mem-01-staging-db', '0', 'done', 'FAIL', 'max_steps', '30', '$0.000161', '15.8 s', '2', '']);
    expect(rows(wrapper)[1].find('.fail').text()).toBe('FAIL');
    expect(rows(wrapper)[0].find('.pass').text()).toBe('PASS');

    const t3 = rows(wrapper)[2].findAll('td').map((td) => td.text());
    expect(t3).toEqual(['hermes memory off', 'mem-01-staging-db', '1', 'errored', '-', '', 'n/a', 'n/a', 'n/a', '0', 'provider_error']);

    const links = rows(wrapper)[1].findAll('a').map((a) => a.attributes('href'));
    expect(links).toEqual(['/trials/T2', '/trials/T2']);
  });

  it('narrows the rows and the "showing X of Y trials" text with each filter', async () => {
    const { wrapper } = await mountView();
    const showing = () => wrapper.find('[data-test="showing"]').text();
    expect(showing()).toBe('showing 6 of 6 trials');

    await wrapper.find('[data-test="filter-config"]').setValue('CFG-B');
    expect(rowIds(wrapper)).toEqual(['T4', 'T5', 'T6']);
    expect(showing()).toBe('showing 3 of 6 trials');

    await wrapper.find('[data-test="filter-task"]').setValue('mem-01-staging-db');
    expect(rowIds(wrapper)).toEqual(['T5', 'T6']);
    expect(showing()).toBe('showing 2 of 6 trials');

    await wrapper.find('[data-test="filter-status"]').setValue('running');
    expect(rowIds(wrapper)).toEqual(['T6']);
    expect(showing()).toBe('showing 1 of 6 trials');

    await wrapper.find('[data-test="filter-status"]').setValue('');
    await wrapper.find('[data-test="filter-passed"]').setValue('passed');
    expect(rowIds(wrapper)).toEqual(['T5']);

    await wrapper.find('[data-test="filter-config"]').setValue('');
    await wrapper.find('[data-test="filter-task"]').setValue('');
    expect(rowIds(wrapper)).toEqual(['T1', 'T4', 'T5']);
    await wrapper.find('[data-test="filter-passed"]').setValue('failed');
    expect(rowIds(wrapper)).toEqual(['T2']);
    expect(showing()).toBe('showing 1 of 6 trials');

    await wrapper.find('[data-test="filter-config"]').setValue('CFG-B');
    expect(rowIds(wrapper)).toEqual([]);
    expect(showing()).toBe('showing 0 of 6 trials');
    expect(wrapper.text()).toContain('No trials match.');
  });

  it('keeps the filter selection across a poll that replaces the rows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    withStatus('running');
    const { wrapper } = await mountView();
    await wrapper.find('[data-test="filter-config"]').setValue('CFG-A');
    expect(rowIds(wrapper)).toEqual(['T1', 'T2', 'T3']);
    trialsSpy.mockResolvedValue([...TRIALS, trial({ id: 'T7', config_id: 'CFG-A', trial_index: 2 })]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(rowIds(wrapper)).toEqual(['T1', 'T2', 'T3', 'T7']);
    expect(wrapper.find('[data-test="showing"]').text()).toBe('showing 4 of 7 trials');
  });

  it('shows a trials error inline and still renders the rest of the page', async () => {
    trialsSpy.mockRejectedValue(new ApiError(500, 'trials unavailable', ['db timeout'], null));
    const { wrapper } = await mountView();
    expect(wrapper.find('[data-test="trials-error"]').text()).toContain('trials unavailable');
    expect(wrapper.find('[data-test="trials-error"]').text()).toContain('db timeout');
    expect(wrapper.find('h1').text()).toContain('memory walk');
  });

  it('lists the pinned tasks with category and an 8 char hash prefix in a collapsed details element', async () => {
    const { wrapper } = await mountView();
    const details = wrapper.find('details[data-test="pinned-tasks"]');
    expect(details.attributes('open')).toBeUndefined();
    const text = details.text();
    expect(text).toContain('mem-01-staging-db');
    expect(text).toContain('memory_dependent');
    expect(text).toContain('b8a97dac');
    expect(text).not.toContain('b8a97dac1');
  });
});

describe('ExperimentDetailView pilot panel', () => {
  it('renders the variance, the targets and the projections, and none of delta, verdict, winner, better', async () => {
    pilotSpy.mockResolvedValue(PILOT_READY);
    const { wrapper } = await mountView();
    expect(pilotSpy).toHaveBeenCalledWith(ID);
    const panel = wrapper.find('[data-test="pilot"]');
    const text = panel.text();
    expect(defs(panel)).toEqual({
      Ready: 'yes',
      'Pilot trials per cell': '2',
      Tasks: '3',
      'Judged tasks': '0',
      Configs: '2',
      'Within-task variance': '0.1250',
      'Bernoulli bound variance': '0.2500',
      'Target half-width': '0.150',
      'N cap': '8',
      'Recommended N': '5',
      Capped: 'no',
    });
    expect(text).toContain('The smallest N whose projected half-width is at most the target.');
    const projRows = panel.findAll('table.projections tbody tr').map((tr) => tr.findAll('td').map((td) => td.text()));
    expect(projRows).toEqual([
      ['2', '0.100', '0.200', '0.566', '12'],
      ['5', '0.012', '0.030', '0.358', '30'],
    ]);
    expect(text).not.toMatch(BANNED);
    expect(panel.find('a').exists()).toBe(false);
  });

  it('when not ready, shows the reason and no projections, and still none of the forbidden words', async () => {
    pilotSpy.mockResolvedValue(PILOT_NOT_READY);
    const { wrapper } = await mountView();
    const panel = wrapper.find('[data-test="pilot"]');
    expect(panel.find('[data-test="pilot-reason"]').text()).toContain('no finished trials yet: run at least 1 trial per cell');
    const d = defs(panel);
    expect(d.Ready).toBe('no');
    expect(d['Within-task variance']).toBe('n/a');
    expect(d['Recommended N']).toBe('none');
    expect(panel.find('table.projections').exists()).toBe(false);
    expect(panel.text()).not.toMatch(BANNED);
  });

  it('a failed pilot request shows an inline error and leaves the rest of the page working', async () => {
    pilotSpy.mockRejectedValue(new ApiError(500, 'pilot exploded', ['stats worker down'], null));
    const { wrapper } = await mountView();
    const box = wrapper.find('[data-test="pilot-error"]');
    expect(box.classes()).toContain('error');
    expect(box.text()).toContain('pilot exploded');
    expect(box.text()).toContain('stats worker down');
    expect(rowIds(wrapper)).toHaveLength(6);
    expect(wrapper.find('h1').text()).toContain('memory walk');
  });

  it('reads the pilot again when progress.done changes, not on a poll where nothing changed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const prog = (done: number) => ({ pending: 8 - done, running: 0, done, errored: 0, cancelled: 0, total: 8 });
    getSpy
      .mockResolvedValueOnce(exp({ status: 'running', progress: prog(1) }))
      .mockResolvedValueOnce(exp({ status: 'running', progress: prog(1) }))
      .mockResolvedValueOnce(exp({ status: 'running', progress: prog(3) }))
      .mockResolvedValue(exp({ status: 'completed', progress: prog(3) }));
    await mountView();
    expect(pilotSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000); // done 1 again
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(pilotSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000); // done 3
    expect(pilotSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000); // status completed, done still 3
    expect(getSpy).toHaveBeenCalledTimes(4);
    expect(pilotSpy).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10000);
    expect(pilotSpy).toHaveBeenCalledTimes(3);
  });
});

describe('ExperimentDetailView compare and exports', () => {
  it('links Compare to the compare route with a and b, defaulting to the 1st and 2nd config', async () => {
    const { wrapper } = await mountView();
    const link = wrapper.find('a[data-test="compare"]');
    expect(link.exists()).toBe(true);
    expect(link.attributes('href')).toBe(`/experiments/${ID}/compare?a=CFG-A&b=CFG-B`);
    expect((wrapper.find('#pick-a').element as HTMLSelectElement).value).toBe('CFG-A');
    expect((wrapper.find('#pick-b').element as HTMLSelectElement).value).toBe('CFG-B');
    await wrapper.find('#pick-a').setValue('CFG-B');
    await wrapper.find('#pick-b').setValue('CFG-A');
    expect(wrapper.find('a[data-test="compare"]').attributes('href')).toBe(`/experiments/${ID}/compare?a=CFG-B&b=CFG-A`);
  });

  it('renders Compare as a disabled button, not a link, when A equals B', async () => {
    const { wrapper } = await mountView();
    await wrapper.find('#pick-b').setValue('CFG-A');
    expect(wrapper.find('a[data-test="compare"]').exists()).toBe(false);
    expect(btn(wrapper, 'compare').attributes('disabled')).toBeDefined();
    expect(wrapper.find('a[data-test="compare-csv"]').exists()).toBe(false);
  });

  it('renders Compare disabled with fewer than 2 configs', async () => {
    getSpy.mockResolvedValue(exp({ configs: [{ id: 'CFG-A', name: 'solo config', position: 0, harness_id: 'hermes', model_slug: 'm' }] }));
    const { wrapper } = await mountView();
    expect(wrapper.find('a[data-test="compare"]').exists()).toBe(false);
    expect(btn(wrapper, 'compare').attributes('disabled')).toBeDefined();
  });

  it('has download anchors for Export JSON, Export CSV and Compare CSV with the expected hrefs', async () => {
    const { wrapper } = await mountView();
    const json = wrapper.find('a[data-test="export-json"]');
    const csv = wrapper.find('a[data-test="export-csv"]');
    const cmp = wrapper.find('a[data-test="compare-csv"]');
    expect(json.attributes('href')).toBe(api.exportJsonUrl(ID));
    expect(json.attributes('href')).toBe(`/api/experiments/${ID}/export.json`);
    expect(csv.attributes('href')).toBe(`/api/experiments/${ID}/export.csv`);
    expect(cmp.attributes('href')).toBe(`/api/experiments/${ID}/compare.csv?a=CFG-A&b=CFG-B`);
    for (const a of [json, csv, cmp]) expect(a.element.hasAttribute('download')).toBe(true);
    expect(json.text()).toBe('Export JSON');
    expect(csv.text()).toBe('Export CSV');
    expect(cmp.text()).toBe('Compare CSV');
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('ExperimentDetailView request ordering guards', () => {
  it('a poll tick that fires while an action refresh is in flight is skipped, not queued behind it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const held = deferred<ExperimentDetail>();
    getSpy
      .mockResolvedValueOnce(exp({ status: 'running' }))
      .mockImplementationOnce(() => held.promise)
      .mockResolvedValue(exp({ status: 'running' }));
    vi.spyOn(api, 'cancelExperiment').mockResolvedValue(exp({ status: 'running' }));
    const { wrapper } = await mountView();
    await btn(wrapper, 'cancel').trigger('click');
    await vi.advanceTimersByTimeAsync(0);
    expect(getSpy).toHaveBeenCalledTimes(2); // the action refresh, held
    await vi.advanceTimersByTimeAsync(3000); // the old poll timer fires while that refresh is in flight
    expect(getSpy).toHaveBeenCalledTimes(2);
    held.resolve(exp({ status: 'running' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(getSpy).toHaveBeenCalledTimes(2); // the skipped tick did not queue a request of its own
    await vi.advanceTimersByTimeAsync(2999);
    expect(getSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(getSpy).toHaveBeenCalledTimes(3);
  });

  it('an action refresh waits for a poll that is in flight instead of starting a parallel request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const held = deferred<ExperimentDetail>();
    getSpy
      .mockResolvedValueOnce(exp({ status: 'running' }))
      .mockImplementationOnce(() => held.promise)
      .mockResolvedValue(exp({ status: 'running' }));
    vi.spyOn(api, 'cancelExperiment').mockResolvedValue(exp({ status: 'running' }));
    const { wrapper } = await mountView();
    await vi.advanceTimersByTimeAsync(3000); // the poll starts and is held
    expect(getSpy).toHaveBeenCalledTimes(2);
    await btn(wrapper, 'cancel').trigger('click');
    await vi.advanceTimersByTimeAsync(0);
    expect(getSpy).toHaveBeenCalledTimes(2); // the action refresh is parked behind the poll
    held.resolve(exp({ status: 'running' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(getSpy).toHaveBeenCalledTimes(3); // and runs once the poll has settled
  });

  it('a slow response for the previous id never replaces the data of the new id', async () => {
    const a = deferred<ExperimentDetail>();
    const b = deferred<ExperimentDetail>();
    getSpy.mockImplementation((id: string) => (id === 'EXP1' ? a.promise : b.promise));
    const { wrapper } = await mountView();
    expect(wrapper.text()).toContain('Loading experiment');
    await wrapper.setProps({ id: 'EXP2' });
    await flushPromises();
    a.resolve(exp({ id: 'EXP1', name: 'old experiment' }));
    await flushPromises();
    expect(wrapper.text()).not.toContain('old experiment');
    expect(wrapper.find('h1').exists()).toBe(false);
    b.resolve(exp({ id: 'EXP2', name: 'new experiment' }));
    await flushPromises();
    expect(wrapper.find('h1').text()).toContain('new experiment');
    expect(wrapper.text()).not.toContain('old experiment');
  });

  it('a slow older pilot response never replaces a newer one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const prog = (done: number) => ({ pending: 8 - done, running: 0, done, errored: 0, cancelled: 0, total: 8 });
    getSpy.mockResolvedValueOnce(exp({ status: 'running', progress: prog(1) })).mockResolvedValue(exp({ status: 'running', progress: prog(3) }));
    const slow = deferred<PilotPayload>();
    pilotSpy.mockImplementationOnce(() => slow.promise).mockResolvedValue({ ...PILOT_READY, n_pilot: 4 });
    const { wrapper } = await mountView();
    await vi.advanceTimersByTimeAsync(3000); // done 1 to 3 starts a 2nd pilot read, which settles at once
    expect(pilotSpy).toHaveBeenCalledTimes(2);
    expect(defs(wrapper.find('[data-test="pilot"]'))['Pilot trials per cell']).toBe('4');
    slow.resolve({ ...PILOT_READY, n_pilot: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(defs(wrapper.find('[data-test="pilot"]'))['Pilot trials per cell']).toBe('4');
  });

  it('reads the pilot again after Extend on a draft, where only n_trials changes', async () => {
    getSpy.mockResolvedValueOnce(exp({ status: 'draft', n_trials: 2 })).mockResolvedValue(exp({ status: 'draft', n_trials: 6 }));
    pilotSpy.mockResolvedValueOnce({ ...PILOT_READY, n_pilot: 2 }).mockResolvedValue({ ...PILOT_READY, n_pilot: 6 });
    vi.spyOn(api, 'extendExperiment').mockResolvedValue(exp({ status: 'draft', n_trials: 6 }));
    const { wrapper } = await mountView();
    expect(pilotSpy).toHaveBeenCalledTimes(1);
    expect(defs(wrapper.find('[data-test="pilot"]'))['Pilot trials per cell']).toBe('2');
    await wrapper.find('#extend-to').setValue('6');
    await btn(wrapper, 'extend').trigger('click');
    await flushPromises();
    expect(pilotSpy).toHaveBeenCalledTimes(2);
    expect(defs(wrapper.find('[data-test="pilot"]'))['Pilot trials per cell']).toBe('6');
  });
});

describe('ExperimentDetailView configs that share a name', () => {
  const twin = (): ExperimentDetail =>
    exp({
      configs: [
        { id: 'CFG-A', name: 'hermes memory off', position: 0, harness_id: 'hermes', model_slug: 'm' },
        { id: 'CFG-B', name: 'hermes memory off', position: 1, harness_id: 'hermes', model_slug: 'm' },
        { id: 'CFG-C', name: 'unique one', position: 2, harness_id: 'hermes', model_slug: 'm' },
      ],
    });

  it('tells them apart in the A and B selects, the config filter and the trials Config column', async () => {
    getSpy.mockResolvedValue(twin());
    const { wrapper } = await mountView();
    const labels = ['hermes memory off (#1, hermes, m)', 'hermes memory off (#2, hermes, m)', 'unique one'];
    for (const sel of ['#pick-a', '#pick-b']) {
      expect(wrapper.find(sel).findAll('option').map((o) => o.text())).toEqual(labels);
    }
    expect(wrapper.find('[data-test="filter-config"]').findAll('option').map((o) => o.text())).toEqual(['all', ...labels]);
    const cell = (id: string): string => wrapper.find(`tr[data-trial="${id}"] td`).text();
    expect(cell('T1')).toBe('hermes memory off (#1, hermes, m)');
    expect(cell('T4')).toBe('hermes memory off (#2, hermes, m)');
    // The option values stay the ids, so Compare still targets the right configs.
    expect(wrapper.find('a[data-test="compare"]').attributes('href')).toBe(`/experiments/${ID}/compare?a=CFG-A&b=CFG-B`);
  });

  it('leaves names that are unique inside the experiment untouched', async () => {
    const { wrapper } = await mountView();
    expect(wrapper.find('#pick-a').findAll('option').map((o) => o.text())).toEqual(['hermes memory off', 'hermes memory seeded']);
  });
});
