import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { api, ApiError } from '../../api/client';
import type { Config, CreateConfigBody, CreateConfigResult, Harness, Model, Task } from '../../api/types';
import { routes } from '../../router';
import ConfigsView from '../ConfigsView.vue';

const HASH_1 = 'aaaaaaaa11111111111111111111111111111111111111111111111111111111';
const HASH_2 = 'bbbbbbbb22222222222222222222222222222222222222222222222222222222';
const HASH_3 = 'cccccccc33333333333333333333333333333333333333333333333333333333';

function config(over: Partial<Config> & Pick<Config, 'id' | 'name' | 'config_hash' | 'created_at'>): Config {
  return {
    harness_id: 'hermes',
    harness_version: 'f4ac0bea1e',
    model_id: 'model-b',
    model_slug: 'openai/gpt-oss-20b',
    settings: {
      tools: ['shell', 'files'],
      memory: { mode: 'off', fixture: null, fixture_hash: null },
      skills: { enabled: false, preload: [] },
      temperature: 0,
      max_steps: 15,
      max_output_tokens: 2048,
      timeout_seconds: 300,
      harness_options: {},
    },
    ...over,
  };
}

// API order: oldest first.
const CONFIGS: Config[] = [
  config({ id: '01CFG0000000000000000000A1', name: 'hermes memory off', config_hash: HASH_1, created_at: '2026-10-23T22:30:58.804Z' }),
  config({
    id: '01CFG0000000000000000000B2',
    name: 'hermes memory seeded',
    config_hash: HASH_2,
    created_at: '2026-10-23T22:31:40.186Z',
    settings: {
      tools: ['shell', 'files'],
      memory: { mode: 'seeded', fixture: 'team-memory-v1', fixture_hash: 'f'.repeat(64) },
      skills: { enabled: true, preload: ['triage'] },
      temperature: 0,
      max_steps: 15,
      max_output_tokens: 2048,
      timeout_seconds: 300,
      harness_options: {},
    },
  }),
  config({
    id: '01CFG0000000000000000000C3',
    name: 'minimal loop plain',
    harness_id: 'minimal_loop',
    harness_version: '1.1.0+590a68fe',
    config_hash: HASH_3,
    created_at: '2026-10-24T15:30:00.000Z',
  }),
];

const caps = { seed: false, tools: ['files', 'shell'] as Array<'files' | 'shell'>, skills: true, temperature: true, memory_modes: ['off', 'seeded'] as Array<'off' | 'seeded'>, memory_writes: true, system_prompt_capture: true };

// GET /harnesses: newest version first within an id.
const HARNESSES: Harness[] = [
  { id: 'hermes', version: 'f4ac0bea1e', capabilities: caps, recorded_at: '2026-10-23T22:14:54.611Z' },
  { id: 'minimal_loop', version: '1.1.0+590a68fe', capabilities: { ...caps, skills: false, memory_writes: false, seed: true }, recorded_at: '2026-10-24T15:23:07.363Z' },
  { id: 'minimal_loop', version: '1.0.0+590a68fe', capabilities: { ...caps, skills: false, memory_writes: false, seed: true }, recorded_at: '2026-10-23T23:12:06.701Z' },
];

const MODELS: Model[] = [
  {
    id: 'model-a',
    display_name: 'Anthropic: Claude Haiku 5.5',
    slug: 'anthropic/claude-haiku-5.5',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_env: 'OPENROUTER_API_KEY',
    input_price_per_mtok: 0.1,
    output_price_per_mtok: 0.5,
    context_window: 1000000,
    roles: ['candidate', 'judge'],
    created_at: '2026-10-23T22:14:54.379Z',
  },
  {
    id: 'model-b',
    display_name: 'OpenAI: gpt-oss-20b',
    slug: 'openai/gpt-oss-20b',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_env: 'OPENROUTER_API_KEY',
    input_price_per_mtok: 0.018,
    output_price_per_mtok: 0.09,
    context_window: 131072,
    roles: ['candidate'],
    created_at: '2026-10-23T22:14:54.492Z',
  },
];

function task(id: string, memory_fixture: string | null): Task {
  return { id, version_hash: 'h'.repeat(16), category: 'neutral_deterministic', prompt: 'p', fixture_dir: null, memory_fixture, graders: [], discriminates: null, tags: [] };
}
const TASKS: Task[] = [task('t1', 'team-memory-v1'), task('t2', null), task('t3', 'team-memory-v1'), task('t4', 'ops-memory-v2')];

const SAVED: Config = config({ id: '01CFG0000000000000000000D4', name: 'saved name', config_hash: 'dddddddd' + '4'.repeat(56), created_at: '2026-10-25T10:00:00.000Z' });

let wrapper: VueWrapper | null = null;

async function mountView(): Promise<VueWrapper> {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/configs');
  await router.isReady();
  const w = mount(ConfigsView, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
  wrapper = w;
  return w;
}

function spies() {
  return {
    listConfigs: vi.spyOn(api, 'listConfigs').mockResolvedValue(CONFIGS),
    listHarnesses: vi.spyOn(api, 'listHarnesses').mockResolvedValue(HARNESSES),
    listModels: vi.spyOn(api, 'listModels').mockResolvedValue(MODELS),
    listTasks: vi.spyOn(api, 'listTasks').mockResolvedValue(TASKS),
    createConfig: vi.spyOn(api, 'createConfig'),
  };
}

const created = (c: Config): CreateConfigResult => ({ created: true, config: c });

async function submit(w: VueWrapper): Promise<void> {
  await w.find('form').trigger('submit');
  await flushPromises();
}

function lastBody(s: ReturnType<typeof spies>): CreateConfigBody {
  const calls = s.createConfig.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('ConfigsView list', () => {
  it('renders each config with harness@version, memory mode, fixture and an 8 character hash prefix, newest first', async () => {
    spies();
    const w = await mountView();
    const rows = w.findAll('tr.config-row');
    expect(rows).toHaveLength(3);
    // newest first, although the API returned oldest first
    expect(rows.map((r) => r.find('.cfg-name').text())).toEqual(['minimal loop plain', 'hermes memory seeded', 'hermes memory off']);
    expect(rows[0].find('.cfg-harness').text()).toBe('minimal_loop@1.1.0+590a68fe');
    expect(rows[1].find('.cfg-harness').text()).toBe('hermes@f4ac0bea1e');
    expect(rows[1].find('.cfg-memory').text()).toBe('seeded (team-memory-v1)');
    expect(rows[2].find('.cfg-memory').text()).toBe('off');
    expect(rows[1].find('.cfg-model').text()).toBe('openai/gpt-oss-20b');
    const h1 = rows[2].find('.cfg-hash');
    expect(h1.text()).toBe('aaaaaaaa');
    expect(h1.text()).toHaveLength(8);
    expect(h1.attributes('title')).toBe(HASH_1);
    expect(rows[1].find('.cfg-hash').text()).toBe('bbbbbbbb');
    expect(rows[0].find('.cfg-hash').text()).toBe('cccccccc');
    // tools and skills column
    expect(rows[1].find('.cfg-tools').text()).toContain('tools: shell, files');
    expect(rows[1].find('.cfg-tools').text()).toContain('skills on (preload triage)');
    expect(rows[2].find('.cfg-tools').text()).toContain('skills off');
  });

  it('shows the list load error inline with its detail lines', async () => {
    const s = spies();
    s.listConfigs.mockRejectedValue(new ApiError(500, 'database is down', ['pool exhausted'], null));
    const w = await mountView();
    expect(w.find('.error').text()).toContain('database is down');
    expect(w.find('.error li').text()).toBe('pool exhausted');
    // a failed load must not also claim that there are no configs
    expect(w.text()).not.toContain('no configs yet');
    expect(w.text()).toContain('the config list was not loaded');
  });

  it('says no configs yet when the list loaded and is empty', async () => {
    const s = spies();
    s.listConfigs.mockResolvedValue([]);
    const w = await mountView();
    expect(w.text()).toContain('no configs yet');
    expect(w.find('.error').exists()).toBe(false);
  });

  it('keeps a harnesses load error visible after a successful create reloads the list', async () => {
    const s = spies();
    s.listHarnesses.mockRejectedValue(new ApiError(503, 'harness registry unavailable', [], null));
    s.createConfig.mockResolvedValue(created(SAVED));
    const w = await mountView();
    expect(w.find('.error').text()).toContain('harness registry unavailable');
    await submit(w);
    expect(s.listConfigs).toHaveBeenCalledTimes(2);
    expect(w.text()).toContain('harness registry unavailable');
  });

  it('clears a list load error once a later reload succeeds', async () => {
    const s = spies();
    s.listConfigs.mockRejectedValueOnce(new ApiError(500, 'database is down', [], null));
    s.createConfig.mockResolvedValue(created(SAVED));
    const w = await mountView();
    expect(w.text()).toContain('database is down');
    await submit(w);
    expect(w.text()).not.toContain('database is down');
    expect(w.findAll('tr.config-row')).toHaveLength(3);
  });
});

describe('ConfigsView form options', () => {
  it('offers the newest version of each harness id, all models, and the distinct task fixtures', async () => {
    spies();
    const w = await mountView();
    const harnessOptions = w.findAll('#cfg-harness option').map((o) => o.text());
    expect(harnessOptions).toEqual(['hermes@f4ac0bea1e', 'minimal_loop@1.1.0+590a68fe']);
    expect(w.findAll('#cfg-model option').map((o) => o.text())).toEqual([
      'Anthropic: Claude Haiku 5.5 (anthropic/claude-haiku-5.5)',
      'OpenAI: gpt-oss-20b (openai/gpt-oss-20b)',
    ]);
    const fixtures = w.findAll('#cfg-memory-fixture option').map((o) => o.attributes('value'));
    expect(fixtures).toEqual(['', 'ops-memory-v2', 'team-memory-v1']);
  });

  it('shows the capabilities of the selected harness as plain text and does not disable skills for a harness without them', async () => {
    spies();
    const w = await mountView();
    expect(w.find('.harness-hint').text()).toContain('skills: yes');
    await w.find('#cfg-harness').setValue('minimal_loop');
    expect(w.find('.harness-hint').text()).toContain('skills: no');
    expect(w.find('#cfg-skills').attributes('disabled')).toBeUndefined();
    expect(w.find('#cfg-preload').attributes('disabled')).toBeUndefined();
  });

  it('disables the fixture select unless memory mode is seeded', async () => {
    spies();
    const w = await mountView();
    expect(w.find('#cfg-memory-fixture').attributes('disabled')).toBeDefined();
    await w.find('#cfg-memory-mode').setValue('seeded');
    expect(w.find('#cfg-memory-fixture').attributes('disabled')).toBeUndefined();
  });
});

describe('ConfigsView submit', () => {
  it('shows the API refusal reasons inline and keeps the form values', async () => {
    const s = spies();
    s.createConfig.mockRejectedValue(
      new ApiError(400, 'config refused by the adapter', ['the minimal loop has no skills; skills.enabled must be false'], null),
    );
    const w = await mountView();
    await w.find('#cfg-name').setValue('minimal with skills');
    await w.find('#cfg-harness').setValue('minimal_loop');
    await w.find('#cfg-skills').setValue(true);
    await submit(w);
    const box = w.find('.submit-error');
    expect(box.exists()).toBe(true);
    expect(box.find('.submit-error-message').text()).toBe('config refused by the adapter');
    expect(box.findAll('li').map((li) => li.text())).toEqual(['the minimal loop has no skills; skills.enabled must be false']);
    expect((w.find('#cfg-name').element as HTMLInputElement).value).toBe('minimal with skills');
    expect((w.find('#cfg-harness').element as HTMLSelectElement).value).toBe('minimal_loop');
    expect((w.find('#cfg-skills').element as HTMLInputElement).checked).toBe(true);
    expect(w.find('.submit-notice').exists()).toBe(false);
    // the form can be fixed and resubmitted
    s.createConfig.mockResolvedValue(created(SAVED));
    await w.find('#cfg-skills').setValue(false);
    await submit(w);
    expect(s.createConfig).toHaveBeenCalledTimes(2);
    expect(w.find('.submit-error').exists()).toBe(false);
    expect(lastBody(s).settings.skills.enabled).toBe(false);
  });

  it('shows the created notice and reloads the list after a 201', async () => {
    const s = spies();
    s.createConfig.mockResolvedValue(created(SAVED));
    const w = await mountView();
    expect(s.listConfigs).toHaveBeenCalledTimes(1);
    s.listConfigs.mockResolvedValue([...CONFIGS, SAVED]);
    await w.find('#cfg-name').setValue('saved name');
    await submit(w);
    expect(w.find('.submit-notice').text()).toBe('created config saved name (01CFG0000000000000000000D4)');
    expect(s.listConfigs).toHaveBeenCalledTimes(2);
    const names = w.findAll('tr.config-row .cfg-name').map((n) => n.text());
    expect(names[0]).toBe('saved name');
    expect(names).toHaveLength(4);
  });

  it('says a config with the same content already exists on a 200 and that the typed name was not stored', async () => {
    const s = spies();
    s.createConfig.mockResolvedValue({ created: false, config: CONFIGS[0] });
    const w = await mountView();
    await w.find('#cfg-name').setValue('my duplicate');
    await submit(w);
    const text = w.find('.submit-notice').text();
    expect(text).toContain('a config with the same content already exists: hermes memory off (01CFG0000000000000000000A1); nothing was created');
    expect(text).toContain('my duplicate');
    expect(text).toContain('was not stored');
    expect(text).not.toContain('created config');
  });

  it('sends the documented body shape with numbers as numbers and the parsed harness_options', async () => {
    const s = spies();
    s.createConfig.mockResolvedValue(created(SAVED));
    const w = await mountView();
    await w.find('#cfg-name').setValue('  full shape  ');
    await w.find('#cfg-harness').setValue('hermes');
    await w.find('#cfg-model').setValue('model-a');
    await w.find('[data-tool="files"]').setValue(false);
    await w.find('#cfg-memory-mode').setValue('seeded');
    await w.find('#cfg-memory-fixture').setValue('ops-memory-v2');
    await w.find('#cfg-skills').setValue(true);
    await w.find('#cfg-preload').setValue('alpha, beta');
    await w.find('#cfg-temperature').setValue('0.5');
    await w.find('#cfg-max-steps').setValue('20');
    await w.find('#cfg-max-output-tokens').setValue('4096');
    await w.find('#cfg-timeout').setValue('120');
    await w.find('#cfg-harness-options').setValue('{"providers_ignored": ["Darkbloom", "Groq"]}');
    await submit(w);
    const body = lastBody(s);
    expect(body).toEqual({
      name: 'full shape',
      harness_id: 'hermes',
      model_id: 'model-a',
      settings: {
        tools: ['shell'],
        memory: { mode: 'seeded', fixture: 'ops-memory-v2' },
        skills: { enabled: true, preload: ['alpha', 'beta'] },
        temperature: 0.5,
        max_steps: 20,
        max_output_tokens: 4096,
        timeout_seconds: 120,
        harness_options: { providers_ignored: ['Darkbloom', 'Groq'] },
      },
    });
    expect(typeof body.settings.temperature).toBe('number');
    expect(typeof body.settings.max_steps).toBe('number');
    expect(typeof body.settings.max_output_tokens).toBe('number');
    expect(typeof body.settings.timeout_seconds).toBe('number');
  });

  it('sends the defaults when nothing is touched, with both tools and memory fixture null', async () => {
    const s = spies();
    s.createConfig.mockResolvedValue(created(SAVED));
    const w = await mountView();
    await w.find('#cfg-name').setValue('defaults');
    await submit(w);
    expect(lastBody(s)).toEqual({
      name: 'defaults',
      harness_id: 'hermes',
      model_id: 'model-a',
      settings: {
        tools: ['shell', 'files'],
        memory: { mode: 'off', fixture: null },
        skills: { enabled: false, preload: [] },
        temperature: 0,
        max_steps: 15,
        max_output_tokens: 2048,
        timeout_seconds: 300,
        harness_options: {},
      },
    });
  });

  it('sends the chosen fixture when seeded and null when off, even if a fixture was picked before switching back', async () => {
    const s = spies();
    s.createConfig.mockResolvedValue(created(SAVED));
    const w = await mountView();
    await w.find('#cfg-name').setValue('mem');
    await w.find('#cfg-memory-mode').setValue('seeded');
    await w.find('#cfg-memory-fixture').setValue('team-memory-v1');
    await submit(w);
    expect(lastBody(s).settings.memory).toEqual({ mode: 'seeded', fixture: 'team-memory-v1' });
    await w.find('#cfg-memory-mode').setValue('off');
    await submit(w);
    expect(s.createConfig).toHaveBeenCalledTimes(2);
    expect(lastBody(s).settings.memory).toEqual({ mode: 'off', fixture: null });
  });

  it('blocks the submit and sends nothing when harness_options is invalid JSON', async () => {
    const s = spies();
    const w = await mountView();
    await w.find('#cfg-name').setValue('bad json');
    await w.find('#cfg-harness-options').setValue('{"providers_ignored": [');
    await submit(w);
    expect(s.createConfig).not.toHaveBeenCalled();
    expect(w.find('.submit-error').text()).toContain('harness_options is not valid JSON');
    expect((w.find('#cfg-name').element as HTMLInputElement).value).toBe('bad json');
  });

  it('blocks the submit when a numeric field is blank and names the field', async () => {
    const s = spies();
    s.createConfig.mockResolvedValue(created(SAVED));
    const w = await mountView();
    for (const [id, label] of [
      ['#cfg-max-steps', 'max_steps'],
      ['#cfg-temperature', 'temperature'],
      ['#cfg-max-output-tokens', 'max_output_tokens'],
      ['#cfg-timeout', 'timeout_seconds'],
    ]) {
      await w.find(id).setValue('');
      await submit(w);
      expect(w.find('.submit-error').text()).toContain(`${label} must be a number`);
      expect(s.createConfig).not.toHaveBeenCalled();
      await w.find(id).setValue('5');
    }
  });

  it('reports every form problem in one box instead of only the first', async () => {
    const s = spies();
    const w = await mountView();
    await w.find('#cfg-harness-options').setValue('{oops');
    await w.find('#cfg-max-steps').setValue('');
    await submit(w);
    expect(s.createConfig).not.toHaveBeenCalled();
    const items = w.findAll('.submit-error li').map((li) => li.text());
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('harness_options is not valid JSON');
    expect(items[1]).toBe('max_steps must be a number');
  });

  it('preselects the first fixture (sorted) when seeded is chosen and sends it', async () => {
    const s = spies();
    s.createConfig.mockResolvedValue(created(SAVED));
    const w = await mountView();
    await w.find('#cfg-memory-mode').setValue('seeded');
    expect((w.find('#cfg-memory-fixture').element as HTMLSelectElement).value).toBe('ops-memory-v2');
    await submit(w);
    expect(lastBody(s).settings.memory).toEqual({ mode: 'seeded', fixture: 'ops-memory-v2' });
  });

  it('omits the "name was not stored" sentence when the typed name equals the existing name', async () => {
    const s = spies();
    s.createConfig.mockResolvedValue({ created: false, config: CONFIGS[0] });
    const w = await mountView();
    await w.find('#cfg-name').setValue('hermes memory off');
    await submit(w);
    const text = w.find('.submit-notice').text();
    expect(text).toContain('already exists: hermes memory off');
    expect(text).not.toContain('was not stored');
  });

  it('blocks the submit when harness_options is JSON but not an object', async () => {
    const s = spies();
    const w = await mountView();
    for (const text of ['[]', '"x"', 'null', '3']) {
      await w.find('#cfg-harness-options').setValue(text);
      await submit(w);
      expect(w.find('.submit-error').text()).toContain('harness_options must be a JSON object');
    }
    expect(s.createConfig).not.toHaveBeenCalled();
  });

  it('turns the preload text "a, b,,c" into ["a","b","c"] and an empty text into []', async () => {
    const s = spies();
    s.createConfig.mockResolvedValue(created(SAVED));
    const w = await mountView();
    await w.find('#cfg-skills').setValue(true);
    await w.find('#cfg-preload').setValue('a, b,,c');
    await submit(w);
    expect(lastBody(s).settings.skills).toEqual({ enabled: true, preload: ['a', 'b', 'c'] });
    await w.find('#cfg-preload').setValue(' , ,');
    await submit(w);
    expect(lastBody(s).settings.skills.preload).toEqual([]);
  });

  it('disables the submit button while the request is in flight', async () => {
    const s = spies();
    let release: (r: CreateConfigResult) => void = () => undefined;
    s.createConfig.mockReturnValue(new Promise<CreateConfigResult>((resolve) => (release = resolve)));
    const w = await mountView();
    const button = w.find('button[type="submit"]');
    expect(button.attributes('disabled')).toBeUndefined();
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(button.attributes('disabled')).toBeDefined();
    // a second submit while in flight sends nothing more
    await w.find('form').trigger('submit');
    expect(s.createConfig).toHaveBeenCalledTimes(1);
    release(created(SAVED));
    await flushPromises();
    expect(button.attributes('disabled')).toBeUndefined();
  });

  it('shows a non-API failure (network) inline instead of swallowing it', async () => {
    const s = spies();
    s.createConfig.mockRejectedValue(new ApiError(0, 'cannot reach the API at /api: Failed to fetch', [], null));
    const w = await mountView();
    await submit(w);
    expect(w.find('.submit-error').text()).toContain('cannot reach the API at /api: Failed to fetch');
  });
});
