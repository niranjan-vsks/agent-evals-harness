import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { api, ApiError } from '../../api/client';
import type { Config, Experiment, ExperimentDetail, Task, TaskCategory } from '../../api/types';
import { routes } from '../../router';
import ExperimentsView from '../ExperimentsView.vue';

const CATEGORIES: TaskCategory[] = ['memory_dependent', 'memory_distractor', 'neutral_deterministic', 'neutral_judged', 'honesty'];

function exp(over: Partial<Experiment> & { id: string }): Experiment {
  return {
    name: `exp ${over.id}`,
    status: 'completed',
    n_trials: 2,
    seed: 7,
    phase: 'full',
    axis: null,
    hypothesis: 'H1: seeded beats off',
    worker_manifest: {},
    created_at: '2026-10-24T22:18:30.192Z',
    started_at: null,
    finished_at: null,
    pause_reason: null,
    paused: false,
    progress: { pending: 0, running: 0, done: 0, errored: 0, cancelled: 0, total: 0 },
    ...over,
  };
}

function config(n: number): Config {
  return {
    id: `CFG${n}`,
    name: `config ${n}`,
    harness_id: n === 3 ? 'minimal_loop' : 'hermes',
    harness_version: `v${n}`,
    model_id: 'M1',
    model_slug: 'openai/gpt-oss-20b',
    settings: {
      tools: ['shell'],
      memory: { mode: 'off', fixture: null, fixture_hash: null },
      skills: { enabled: false, preload: [] },
      temperature: 0,
      max_steps: 10,
      max_output_tokens: 100,
      timeout_seconds: 60,
      harness_options: {},
    },
    config_hash: `${n}abcdef0123456789`,
    created_at: '2026-10-24T00:00:00.000Z',
  };
}

function task(n: number): Task {
  return {
    id: `task-${String(n).padStart(2, '0')}`,
    version_hash: `hash${String(n).padStart(2, '0')}aaaaaaaaaaaa`,
    category: CATEGORIES[n % CATEGORIES.length],
    prompt: 'p',
    fixture_dir: null,
    memory_fixture: null,
    graders: [],
    discriminates: null,
    tags: [],
  };
}

const tasks22 = Array.from({ length: 22 }, (_, i) => task(i));
const configs3 = [config(1), config(2), config(3)];

interface Mounted {
  wrapper: VueWrapper;
  router: ReturnType<typeof createRouter>;
}

async function mountView(): Promise<Mounted> {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/experiments');
  await router.isReady();
  const wrapper = mount(ExperimentsView, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
  return { wrapper, router };
}

const configBoxes = (w: VueWrapper) => w.findAll('.config-option input[type="checkbox"]');
const taskBoxes = (w: VueWrapper) => w.findAll('.task-option input[type="checkbox"]');

async function fillValid(w: VueWrapper): Promise<void> {
  await w.find('#exp-name').setValue('my experiment');
  await configBoxes(w)[0].setValue(true);
  await configBoxes(w)[1].setValue(true);
  await w.find('#exp-hypothesis').setValue('H1: config 2 passes more memory tasks');
}

let listSpy: MockInstance<typeof api.listExperiments>;
let createSpy: MockInstance<typeof api.createExperiment>;
const wrappers: VueWrapper[] = [];

beforeEach(() => {
  listSpy = vi.spyOn(api, 'listExperiments').mockResolvedValue([]);
  vi.spyOn(api, 'listConfigs').mockResolvedValue(configs3);
  vi.spyOn(api, 'listTasks').mockResolvedValue(tasks22);
  createSpy = vi.spyOn(api, 'createExperiment');
});

afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mountTracked(): Promise<Mounted> {
  const m = await mountView();
  wrappers.push(m.wrapper);
  return m;
}

describe('ExperimentsView list', () => {
  it('shows name links, status chips, a paused chip, counts with cancelled only when non-zero, and the progress bar', async () => {
    listSpy.mockResolvedValue([
      exp({ id: 'E1', name: 'running exp', status: 'running', progress: { pending: 3, running: 2, done: 4, errored: 1, cancelled: 0, total: 10 } }),
      exp({
        id: 'E2',
        name: 'paused exp',
        status: 'running',
        paused: true,
        pause_reason: 'circuit breaker',
        progress: { pending: 5, running: 0, done: 2, errored: 1, cancelled: 2, total: 10 },
      }),
      exp({ id: 'E3', name: 'finished exp', status: 'completed', axis: 'memory', progress: { pending: 0, running: 0, done: 6, errored: 0, cancelled: 0, total: 6 } }),
    ]);
    const { wrapper } = await mountTracked();

    const r1 = wrapper.find('tr[data-experiment="E1"]');
    expect(r1.find('a').attributes('href')).toBe('/experiments/E1');
    expect(r1.find('a').text()).toBe('running exp');
    expect(r1.find('.chip-running').text()).toBe('running');
    expect(r1.find('.chip-paused').exists()).toBe(false);
    expect(r1.find('.counts').text()).toBe('done 4, errored 1, pending 3, running 2 of 10');
    const bar1 = r1.find('progress');
    expect(bar1.attributes('value')).toBe('5');
    expect(bar1.attributes('max')).toBe('10');

    const r2 = wrapper.find('tr[data-experiment="E2"]');
    expect(r2.find('.chip-running').exists()).toBe(true);
    expect(r2.find('.chip-paused').text()).toBe('paused');
    expect(r2.find('.counts').text()).toBe('done 2, errored 1, pending 5, running 0, cancelled 2 of 10');
    expect(r2.find('progress').attributes('value')).toBe('5');

    const r3 = wrapper.find('tr[data-experiment="E3"]');
    expect(r3.find('.chip-completed').text()).toBe('completed');
    expect(r3.text()).toContain('memory');
    expect(r3.find('.counts').text()).not.toContain('cancelled');
  });

  it('truncates a long hypothesis to about 80 characters and keeps the full text in the title', async () => {
    const long = `${'x'.repeat(100)} END`;
    listSpy.mockResolvedValue([exp({ id: 'E1', hypothesis: long }), exp({ id: 'E2', hypothesis: 'short text' })]);
    const { wrapper } = await mountTracked();
    const cell = wrapper.find('tr[data-experiment="E1"] .hypothesis');
    expect(cell.attributes('title')).toBe(long);
    expect(cell.text()).toBe(`${'x'.repeat(80)}...`);
    expect(wrapper.find('tr[data-experiment="E2"] .hypothesis').text()).toBe('short text');
  });

  it('shows the API error inline when the list cannot be loaded', async () => {
    listSpy.mockRejectedValue(new ApiError(500, 'database is down', ['connection refused'], null));
    const { wrapper } = await mountTracked();
    const box = wrapper.find('[data-test="list-error"]');
    expect(box.classes()).toContain('error');
    expect(box.text()).toContain('database is down');
    expect(box.text()).toContain('connection refused');
  });
});

describe('ExperimentsView polling', () => {
  it('re-reads the list after 3000 ms while an experiment is running, and stops once none is queued or running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    listSpy
      .mockResolvedValueOnce([exp({ id: 'E1', status: 'running' })])
      .mockResolvedValueOnce([exp({ id: 'E1', status: 'queued' })])
      .mockResolvedValue([exp({ id: 'E1', status: 'completed' })]);
    await mountTracked();
    expect(listSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2999);
    expect(listSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(listSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3000);
    expect(listSpy).toHaveBeenCalledTimes(3);

    // The 3rd answer has nothing active: no further requests.
    await vi.advanceTimersByTimeAsync(30000);
    expect(listSpy).toHaveBeenCalledTimes(3);
  });

  it('does not poll at all when nothing is queued or running (draft, completed, partial, cancelled)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    listSpy.mockResolvedValue([exp({ id: 'E1', status: 'draft' }), exp({ id: 'E2', status: 'completed' }), exp({ id: 'E3', status: 'partial' }), exp({ id: 'E4', status: 'cancelled' })]);
    await mountTracked();
    await vi.advanceTimersByTimeAsync(20000);
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the timer when the view is unmounted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    listSpy.mockResolvedValue([exp({ id: 'E1', status: 'running' })]);
    const { wrapper } = await mountView();
    expect(listSpy).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(10000);
    expect(listSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ExperimentsView create form', () => {
  it('lists the configs with harness@version, model and an 8 char hash prefix, and checks all tasks by default', async () => {
    const { wrapper } = await mountTracked();
    const row1 = wrapper.findAll('.config-option')[0].text();
    expect(row1).toContain('config 1');
    expect(row1).toContain('hermes@v1');
    expect(row1).toContain('openai/gpt-oss-20b');
    expect(row1).toContain('1abcdef0');
    expect(row1).not.toContain('1abcdef01');
    expect(taskBoxes(wrapper)).toHaveLength(22);
    expect(taskBoxes(wrapper).every((b) => (b.element as HTMLInputElement).checked)).toBe(true);
    expect(wrapper.find('[data-test="task-count"]').text()).toBe('22 of 22 tasks checked');
    // grouped by category
    expect(wrapper.findAll('.task-group h3').map((h) => h.text().split(' ')[0])).toEqual(CATEGORIES);
  });

  it('blocks the submit and says why when the hypothesis is empty or only spaces', async () => {
    const { wrapper } = await mountTracked();
    await fillValid(wrapper);
    await wrapper.find('#exp-hypothesis').setValue('   ');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(createSpy).not.toHaveBeenCalled();
    const box = wrapper.find('[data-test="form-problems"]');
    expect(box.classes()).toContain('error');
    expect(box.text()).toContain('Hypothesis is required');
  });

  it('shows the pre-registration hint and the empty-seed hint', async () => {
    const { wrapper } = await mountTracked();
    expect(wrapper.text()).toContain('cannot be changed after the experiment leaves draft');
    expect(wrapper.text()).toContain('Leave empty and the API picks a seed');
  });

  it('blocks the submit when fewer than 2 configs are checked', async () => {
    const { wrapper } = await mountTracked();
    await wrapper.find('#exp-name').setValue('x');
    await wrapper.find('#exp-hypothesis').setValue('H');
    await configBoxes(wrapper)[0].setValue(true);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(createSpy).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="form-problems"]').text()).toContain('at least 2 configs');
  });

  it('blocks the submit for an empty name, no tasks, N below 1 and a bad seed, listing each', async () => {
    const { wrapper } = await mountTracked();
    await fillValid(wrapper);
    await wrapper.find('#exp-name').setValue('  ');
    await wrapper.find('[data-test="tasks-none"]').trigger('click');
    await wrapper.find('#exp-n').setValue('0');
    await wrapper.find('#exp-seed').setValue('abc');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(createSpy).not.toHaveBeenCalled();
    const text = wrapper.find('[data-test="form-problems"]').text();
    expect(text).toContain('Name is required');
    expect(text).toContain('at least 1 task');
    expect(text).toContain('N (trials per cell)');
    expect(text).toContain('Seed must be');
  });

  it('creates with the configs in checked order, every task id explicit, a numeric N, no seed, then opens the draft', async () => {
    createSpy.mockResolvedValue({ id: 'NEWID' } as ExperimentDetail);
    const { wrapper, router } = await mountTracked();
    await wrapper.find('#exp-name').setValue('  walk  ');
    // check config 3 first, then config 1: that order is what must be sent
    await configBoxes(wrapper)[2].setValue(true);
    await configBoxes(wrapper)[0].setValue(true);
    await wrapper.find('#exp-n').setValue('3');
    await wrapper.find('#exp-hypothesis').setValue('  H1: config 3 beats config 1  ');
    await wrapper.find('#exp-phase').setValue('full');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(createSpy).toHaveBeenCalledTimes(1);
    const body = createSpy.mock.calls[0][0];
    expect(body).toStrictEqual({
      name: 'walk',
      config_ids: ['CFG3', 'CFG1'],
      task_ids: tasks22.map((t) => t.id),
      n_trials: 3,
      hypothesis: 'H1: config 3 beats config 1',
      phase: 'full',
    });
    expect(body.task_ids).toHaveLength(22);
    expect(typeof body.n_trials).toBe('number');
    expect('seed' in body).toBe(false);
    expect('axis' in body).toBe(false);
    expect(router.currentRoute.value.fullPath).toBe('/experiments/NEWID');
  });

  it('sends the seed, the axis, the phase, and only the tasks that are still checked', async () => {
    createSpy.mockResolvedValue({ id: 'NEWID' } as ExperimentDetail);
    const { wrapper } = await mountTracked();
    await fillValid(wrapper);
    // the boxes are grouped by category, so find them by value
    await wrapper.find('.task-option input[value="task-00"]').setValue(false);
    await wrapper.find('.task-option input[value="task-05"]').setValue(false);
    await wrapper.find('#exp-seed').setValue('42');
    await wrapper.find('#exp-axis').setValue('memory off vs seeded');
    await wrapper.find('#exp-phase').setValue('pilot');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const body = createSpy.mock.calls[0][0];
    expect(body.seed).toBe(42);
    expect(body.axis).toBe('memory off vs seeded');
    expect(body.phase).toBe('pilot');
    expect(body.n_trials).toBe(5);
    expect(body.config_ids).toEqual(['CFG1', 'CFG2']);
    expect(body.task_ids).toEqual(tasks22.map((t) => t.id).filter((_, i) => i !== 0 && i !== 5));
  });

  it('select none and select all change what is sent', async () => {
    createSpy.mockResolvedValue({ id: 'NEWID' } as ExperimentDetail);
    const { wrapper } = await mountTracked();
    await fillValid(wrapper);
    await wrapper.find('[data-test="tasks-none"]').trigger('click');
    expect(wrapper.find('[data-test="task-count"]').text()).toBe('0 of 22 tasks checked');
    await wrapper.find('[data-test="tasks-all"]').trigger('click');
    expect(wrapper.find('[data-test="task-count"]').text()).toBe('22 of 22 tasks checked');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(createSpy.mock.calls[0][0].task_ids).toHaveLength(22);
  });

  it('shows the API message and every reason inline when the create is refused, and stays on the page', async () => {
    createSpy.mockRejectedValue(new ApiError(400, 'invalid experiment body', ['n_trials: must be at most 1000', 'task_ids: unknown task nope'], null));
    const { wrapper, router } = await mountTracked();
    await fillValid(wrapper);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    const box = wrapper.find('[data-test="submit-error"]');
    expect(box.classes()).toContain('error');
    expect(box.text()).toContain('invalid experiment body');
    expect(box.text()).toContain('n_trials: must be at most 1000');
    expect(box.text()).toContain('task_ids: unknown task nope');
    expect(router.currentRoute.value.fullPath).toBe('/experiments');
  });

  it('shows the error when the configs or tasks cannot be loaded', async () => {
    vi.spyOn(api, 'listTasks').mockRejectedValue(new ApiError(0, 'cannot reach the API at /api: Failed to fetch', [], null));
    const { wrapper } = await mountTracked();
    expect(wrapper.find('[data-test="load-error"]').text()).toContain('cannot reach the API');
  });
});
