<script setup lang="ts">
// Configs list and creation form (cards/P4.md section 6). The browser never validates harness capabilities: the API asks the
// adapter and answers 400 with reasons, and those reasons are shown inline (gate 4a depends on seeing that refusal).
import { computed, onMounted, ref, watch } from 'vue';
import { api, ApiError } from '../api/client';
import type { Capabilities, Config, CreateConfigBody, Harness, MemoryMode, PlatformTool } from '../api/types';
import DataTable from '../components/DataTable.vue';
import EmptyState from '../components/EmptyState.vue';
import Skeleton from '../components/Skeleton.vue';
import { useAppStore } from '../stores/app';
import { hashPrefix, when } from '../lib/format';

interface ErrorView {
  message: string;
  reasons: string[];
}

const ALL_TOOLS: PlatformTool[] = ['shell', 'files'];
const HARNESS_OPTIONS_EXAMPLE = '{"providers_ignored": ["Darkbloom", "Groq"]}';

const store = useAppStore();

// Errors from /harnesses, /models and /tasks, and the separate error from the config list.
const loadErrors = ref<ErrorView[]>([]);
const listError = ref<ErrorView | null>(null);
const loadingList = ref(true);

// form state
const name = ref('');
const harnessId = ref('');
const modelId = ref('');
const tools = ref<PlatformTool[]>([...ALL_TOOLS]);
const memoryMode = ref<MemoryMode>('off');
const memoryFixture = ref('');
const skillsEnabled = ref(false);
const preload = ref('');
const temperature = ref<number | ''>(0);
const maxSteps = ref<number | ''>(15);
const maxOutputTokens = ref<number | ''>(2048);
const timeoutSeconds = ref<number | ''>(300);
const harnessOptionsText = ref('{}');

const submitting = ref(false);
const submitError = ref<ErrorView | null>(null);
const notice = ref<string | null>(null);

const toErrorView = (e: unknown): ErrorView =>
  e instanceof ApiError ? { message: e.message, reasons: e.reasons } : { message: e instanceof Error ? e.message : String(e), reasons: [] };

// Newest first. The API answers oldest first; sorting on created_at keeps this right if that ever changes.
const configs = computed<Config[]>(() =>
  [...(store.configs ?? [])].sort((x, y) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : y.id.localeCompare(x.id))),
);

// 1 row per (id, version), newest version first within an id: the first row of each id is the newest.
const harnessChoices = computed<Harness[]>(() => {
  const seen = new Set<string>();
  const out: Harness[] = [];
  for (const h of store.harnesses ?? []) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push(h);
  }
  return out;
});

const selectedHarness = computed(() => harnessChoices.value.find((h) => h.id === harnessId.value) ?? null);

// There is no fixtures endpoint: the fixture names are the distinct memory_fixture values across the tasks.
const fixtureOptions = computed<string[]>(() => {
  const set = new Set<string>();
  for (const t of store.tasks ?? []) if (t.memory_fixture) set.add(t.memory_fixture);
  return [...set].sort();
});

const yesNo = (v: boolean): string => (v ? 'yes' : 'no');
const list = (v: string[]): string => (v.length ? v.join(', ') : 'none');

function capabilityHint(c: Capabilities): string {
  return [
    `tools: ${list(c.tools)}`,
    `memory modes: ${list(c.memory_modes)}`,
    `memory writes: ${yesNo(c.memory_writes)}`,
    `skills: ${yesNo(c.skills)}`,
    `temperature: ${yesNo(c.temperature)}`,
    `seed: ${yesNo(c.seed)}`,
    `system prompt capture: ${yesNo(c.system_prompt_capture)}`,
  ].join('; ');
}

function toolsCell(c: Config): string {
  return list(c.settings.tools);
}

function skillsCell(c: Config): string {
  const s = c.settings.skills;
  if (!s.enabled) return 'skills off';
  return s.preload.length ? `skills on (preload ${s.preload.join(', ')})` : 'skills on';
}

watch(memoryMode, (mode) => {
  if (mode === 'seeded' && !memoryFixture.value && fixtureOptions.value.length) memoryFixture.value = fixtureOptions.value[0];
});

async function loadAll(): Promise<void> {
  const [cfgs, ...others] = await Promise.allSettled([store.loadConfigs(true), store.loadHarnesses(), store.loadModels(), store.loadTasks()]);
  listError.value = cfgs.status === 'rejected' ? toErrorView(cfgs.reason) : null;
  loadErrors.value = others.flatMap((r) => (r.status === 'rejected' ? [toErrorView(r.reason)] : []));
  if (!harnessId.value && harnessChoices.value.length) harnessId.value = harnessChoices.value[0].id;
  if (!modelId.value && store.models?.length) modelId.value = store.models[0].id;
  loadingList.value = false;
}

async function reloadConfigs(): Promise<void> {
  try {
    await store.loadConfigs(true);
    listError.value = null;
  } catch (e) {
    listError.value = toErrorView(e);
  }
}

onMounted(loadAll);

type Parsed<T> = { ok: true; value: T } | { ok: false; error: ErrorView };

function parseHarnessOptions(): Parsed<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(harnessOptionsText.value);
  } catch (e) {
    return { ok: false, error: { message: `harness_options is not valid JSON: ${(e as Error).message}`, reasons: [] } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: { message: 'harness_options must be a JSON object, for example {}', reasons: [] } };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function numberField(label: string, v: number | ''): Parsed<number> {
  if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: { message: `${label} must be a number`, reasons: [] } };
  return { ok: true, value: v };
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  notice.value = null;
  submitError.value = null;

  const options = parseHarnessOptions();
  const temp = numberField('temperature', temperature.value);
  const steps = numberField('max_steps', maxSteps.value);
  const outTokens = numberField('max_output_tokens', maxOutputTokens.value);
  const timeout = numberField('timeout_seconds', timeoutSeconds.value);
  if (!options.ok || !temp.ok || !steps.ok || !outTokens.ok || !timeout.ok) {
    const problems = [options, temp, steps, outTokens, timeout].flatMap((r) => (r.ok ? [] : [r.error]));
    submitError.value = problems.length === 1 ? problems[0] : { message: `${problems.length} problems in the form, nothing was sent`, reasons: problems.map((p) => p.message) };
    return;
  }

  const body: CreateConfigBody = {
    name: name.value.trim(),
    harness_id: harnessId.value,
    model_id: modelId.value,
    settings: {
      tools: ALL_TOOLS.filter((t) => tools.value.includes(t)),
      memory: { mode: memoryMode.value, fixture: memoryMode.value === 'seeded' ? memoryFixture.value || null : null },
      skills: {
        enabled: skillsEnabled.value,
        preload: preload.value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== ''),
      },
      temperature: temp.value,
      max_steps: steps.value,
      max_output_tokens: outTokens.value,
      timeout_seconds: timeout.value,
      harness_options: options.value,
    },
  };

  submitting.value = true;
  try {
    const result = await api.createConfig(body);
    if (result.created) {
      notice.value = `created config ${result.config.name} (${result.config.id})`;
    } else {
      const existing = `a config with the same content already exists: ${result.config.name} (${result.config.id}); nothing was created.`;
      notice.value = body.name === result.config.name ? existing : `${existing} The name you typed (${body.name}) was not stored.`;
    }
    await reloadConfigs();
  } catch (e) {
    submitError.value = toErrorView(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>Configs</h1>
        <p class="page-sub">A config is 1 harness, 1 model and its settings. Configs are immutable: the same content always has the same hash.</p>
      </div>
    </header>

    <div v-for="(err, i) in listError ? [listError, ...loadErrors] : loadErrors" :key="i" class="error" role="alert">
      <div>{{ err.message }}</div>
      <ul v-if="err.reasons.length">
        <li v-for="(r, j) in err.reasons" :key="j">{{ r }}</li>
      </ul>
    </div>

    <section>
      <div class="section-title">
        <h2>Existing configs</h2>
        <span v-if="store.configs !== null && configs.length" class="small muted">{{ configs.length }} configs, newest first</span>
      </div>
      <div v-if="loadingList" class="panel panel-flush">
        <Skeleton :rows="4" />
        <p class="muted small loading-text">loading</p>
      </div>
      <p v-else-if="store.configs === null" class="muted">the config list was not loaded</p>
      <EmptyState v-else-if="!configs.length" title="There are no configs yet.">Create the first one with the form below; an experiment needs 2.</EmptyState>
      <DataTable v-else class="configs-table">
        <thead>
          <tr>
            <th>name</th>
            <th>harness@version</th>
            <th>model</th>
            <th>memory</th>
            <th>tools / skills</th>
            <th>hash</th>
            <th>created</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in configs" :key="c.id" class="config-row">
            <td class="cfg-name">{{ c.name }}</td>
            <td class="mono cfg-harness">{{ c.harness_id }}@{{ c.harness_version }}</td>
            <td class="mono cfg-model">{{ c.model_slug }}</td>
            <td class="cfg-memory">{{ c.settings.memory.mode }}<span v-if="c.settings.memory.fixture" class="muted"> ({{ c.settings.memory.fixture }})</span></td>
            <td class="small cfg-tools">
              <div>tools: {{ toolsCell(c) }}</div>
              <div class="muted">{{ skillsCell(c) }}</div>
            </td>
            <td class="mono cfg-hash" :title="c.config_hash">{{ hashPrefix(c.config_hash) }}</td>
            <td class="mono small muted">{{ when(c.created_at) }}</td>
          </tr>
        </tbody>
      </DataTable>
    </section>

    <section class="panel">
      <div class="section-title">
        <h2>Create a config</h2>
        <span class="small muted">The API asks the harness adapter; settings it cannot honor exactly are refused with reasons.</span>
      </div>
      <form class="form-grid" novalidate @submit.prevent="submit">
        <label for="cfg-name">name</label>
        <input id="cfg-name" v-model="name" type="text" autocomplete="off" />

        <label for="cfg-harness">harness</label>
        <div>
          <select id="cfg-harness" v-model="harnessId">
            <option v-for="h in harnessChoices" :key="h.id" :value="h.id">{{ h.id }}@{{ h.version }}</option>
          </select>
          <div v-if="selectedHarness" class="small muted harness-hint">{{ capabilityHint(selectedHarness.capabilities) }}</div>
        </div>

        <label for="cfg-model">model</label>
        <select id="cfg-model" v-model="modelId">
          <option v-for="m in store.models ?? []" :key="m.id" :value="m.id">{{ m.display_name }} ({{ m.slug }})</option>
        </select>

        <label>tools</label>
        <div class="row checks">
          <label v-for="t in ALL_TOOLS" :key="t" class="check-pill"><input v-model="tools" type="checkbox" :value="t" :data-tool="t" /> {{ t }}</label>
        </div>

        <label for="cfg-memory-mode">memory mode</label>
        <select id="cfg-memory-mode" v-model="memoryMode">
          <option value="off">off</option>
          <option value="seeded">seeded</option>
        </select>

        <label for="cfg-memory-fixture">memory fixture</label>
        <div>
          <select id="cfg-memory-fixture" v-model="memoryFixture" :disabled="memoryMode !== 'seeded'">
            <option value="">(none)</option>
            <option v-for="f in fixtureOptions" :key="f" :value="f">{{ f }}</option>
          </select>
          <div class="hint">used only when memory mode is seeded</div>
        </div>

        <label for="cfg-skills">skills</label>
        <div class="row checks">
          <label class="check-pill"><input id="cfg-skills" v-model="skillsEnabled" type="checkbox" /> enabled</label>
          <label for="cfg-preload" class="small muted">preload</label>
          <input id="cfg-preload" v-model="preload" type="text" placeholder="comma separated skill names" />
        </div>

        <label for="cfg-temperature">temperature</label>
        <input id="cfg-temperature" v-model.number="temperature" type="number" step="any" class="num-input" />

        <label for="cfg-max-steps">max_steps</label>
        <input id="cfg-max-steps" v-model.number="maxSteps" type="number" step="1" class="num-input" />

        <label for="cfg-max-output-tokens">max_output_tokens</label>
        <input id="cfg-max-output-tokens" v-model.number="maxOutputTokens" type="number" step="1" class="num-input" />

        <label for="cfg-timeout">timeout_seconds</label>
        <input id="cfg-timeout" v-model.number="timeoutSeconds" type="number" step="1" class="num-input" />

        <label for="cfg-harness-options">harness_options</label>
        <div>
          <textarea id="cfg-harness-options" v-model="harnessOptionsText" class="mono" spellcheck="false"></textarea>
          <div class="hint">A JSON object. providers_ignored goes here, e.g. <span class="mono">{{ HARNESS_OPTIONS_EXAMPLE }}</span></div>
        </div>

        <span></span>
        <div class="row">
          <button type="submit" class="primary" :disabled="submitting">{{ submitting ? 'creating' : 'Create config' }}</button>
        </div>
      </form>

      <div v-if="submitError" class="error submit-error" role="alert">
        <div class="submit-error-message">{{ submitError.message }}</div>
        <ul v-if="submitError.reasons.length">
          <li v-for="(r, i) in submitError.reasons" :key="i">{{ r }}</li>
        </ul>
      </div>
      <div v-if="notice" class="notice submit-notice" role="status">{{ notice }}</div>
    </section>
  </div>
</template>

<style scoped>
.harness-hint { margin-top: var(--space-1); max-width: 70ch; }
.checks { gap: var(--space-3); }
.check-pill { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-13); cursor: pointer; }
.num-input { width: 120px; }
.loading-text { padding: 0 var(--space-3) var(--space-3); }
.submit-error, .submit-notice { margin-top: var(--space-4); max-width: 820px; }
</style>
