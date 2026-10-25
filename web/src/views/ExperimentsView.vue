<script setup lang="ts">
// Experiments list (polled while anything is queued or running) and the create form (cards/P4.md section 6, S2).
// The UI computes no statistic: progress is the API's counts, the bar is (done + errored + cancelled) / total for display.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, ApiError } from '../api/client';
import type { CreateExperimentBody, Experiment, Phase, Task, TaskCategory } from '../api/types';
import StatusChip from '../components/StatusChip.vue';
import { hashPrefix, when } from '../lib/format';
import { useAppStore } from '../stores/app';

const POLL_MS = 3000;
const HYPOTHESIS_CHARS = 80;
const MAX_SEED = 2 ** 31 - 1;
const CATEGORY_ORDER: TaskCategory[] = ['memory_dependent', 'memory_distractor', 'neutral_deterministic', 'neutral_judged', 'honesty'];

interface Shown {
  message: string;
  reasons: string[];
}
const shown = (e: unknown): Shown =>
  e instanceof ApiError ? { message: e.message, reasons: e.reasons } : { message: e instanceof Error ? e.message : String(e), reasons: [] };

const store = useAppStore();
const router = useRouter();

// ------------------------------------------------------------------ list + polling

const experiments = ref<Experiment[] | null>(null);
const listError = ref<Shown | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;
let alive = true;

const hasActive = computed(() => (experiments.value ?? []).some((e) => e.status === 'queued' || e.status === 'running'));

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

async function loadList(): Promise<void> {
  timer = null;
  try {
    const rows = await api.listExperiments();
    if (!alive) return;
    experiments.value = rows;
    listError.value = null;
  } catch (e) {
    if (!alive) return;
    listError.value = shown(e);
  }
  // The next request is only scheduled after this one has settled, so requests never stack.
  clearTimer();
  if (alive && hasActive.value) timer = setTimeout(loadList, POLL_MS);
}

const finished = (e: Experiment): number => e.progress.done + e.progress.errored + e.progress.cancelled;

function counts(e: Experiment): string {
  const p = e.progress;
  const parts = [`done ${p.done}`, `errored ${p.errored}`, `pending ${p.pending}`, `running ${p.running}`];
  if (p.cancelled > 0) parts.push(`cancelled ${p.cancelled}`);
  return `${parts.join(', ')} of ${p.total}`;
}

function shortHypothesis(text: string | null): string {
  if (!text) return '';
  return text.length > HYPOTHESIS_CHARS ? `${text.slice(0, HYPOTHESIS_CHARS)}...` : text;
}

// ------------------------------------------------------------------ create form

const loadError = ref<Shown | null>(null);
const name = ref('');
const checkedConfigs = ref<string[]>([]);
const checkedTasks = ref<string[]>([]);
// An <input type="number"> hands v-model a number (or '' when empty), so the ref holds either.
const nTrials = ref<number | string>(5);
const seed = ref('');
const axis = ref('');
const hypothesis = ref('');
const phase = ref<Phase>('full');
const problems = ref<string[]>([]);
const submitError = ref<Shown | null>(null);
const submitting = ref(false);

const configs = computed(() => store.configs ?? []);
const tasks = computed<Task[]>(() => store.tasks ?? []);

const taskGroups = computed(() => {
  const by = new Map<TaskCategory, Task[]>();
  for (const t of tasks.value) by.set(t.category, [...(by.get(t.category) ?? []), t]);
  const known = CATEGORY_ORDER.filter((c) => by.has(c));
  const other = [...by.keys()].filter((c) => !CATEGORY_ORDER.includes(c));
  return [...known, ...other].map((category) => ({ category, tasks: by.get(category) ?? [] }));
});

function toggleConfig(id: string, on: boolean): void {
  const rest = checkedConfigs.value.filter((x) => x !== id);
  checkedConfigs.value = on ? [...rest, id] : rest;
}

function toggleTask(id: string, on: boolean): void {
  const rest = checkedTasks.value.filter((x) => x !== id);
  checkedTasks.value = on ? [...rest, id] : rest;
}

const selectAllTasks = (): void => {
  checkedTasks.value = tasks.value.map((t) => t.id);
};
const selectNoTasks = (): void => {
  checkedTasks.value = [];
};

const orderOf = (id: string): number => checkedConfigs.value.indexOf(id) + 1;

async function submit(): Promise<void> {
  submitError.value = null;
  const found: string[] = [];
  const trimmedName = name.value.trim();
  if (!trimmedName) found.push('Name is required.');
  if (checkedConfigs.value.length < 2) found.push('Check at least 2 configs: an experiment compares configs.');
  if (checkedTasks.value.length < 1) found.push('Check at least 1 task.');
  const nText = String(nTrials.value).trim();
  const n = Number(nText);
  if (nText === '' || !Number.isInteger(n) || n < 1) found.push('N (trials per cell) must be an integer of at least 1.');
  const seedText = seed.value.trim();
  let seedValue: number | undefined;
  if (seedText !== '') {
    seedValue = Number(seedText);
    if (!/^\d+$/.test(seedText) || !Number.isSafeInteger(seedValue) || seedValue > MAX_SEED) {
      found.push(`Seed must be an integer from 0 to ${MAX_SEED}, or empty.`);
    }
  }
  const trimmedHypothesis = hypothesis.value.trim();
  if (!trimmedHypothesis) found.push('Hypothesis is required: write down what you expect before the experiment runs.');
  problems.value = found;
  if (found.length > 0) return;

  // The explicit task list is always sent so the pinned set is visible in the request.
  const taskOrder = tasks.value.map((t) => t.id).filter((id) => checkedTasks.value.includes(id));
  const body: CreateExperimentBody = {
    name: trimmedName,
    config_ids: [...checkedConfigs.value],
    task_ids: taskOrder,
    n_trials: n,
    hypothesis: trimmedHypothesis,
    phase: phase.value,
  };
  if (seedValue !== undefined) body.seed = seedValue;
  if (axis.value.trim()) body.axis = axis.value.trim();

  submitting.value = true;
  try {
    const created = await api.createExperiment(body);
    await router.push(`/experiments/${created.id}`);
  } catch (e) {
    submitError.value = shown(e);
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  const loading = (async () => {
    try {
      const [, taskList] = await Promise.all([store.loadConfigs(true), store.loadTasks(true)]);
      if (alive) checkedTasks.value = taskList.map((t) => t.id);
    } catch (e) {
      if (alive) loadError.value = shown(e);
    }
  })();
  await Promise.all([loadList(), loading]);
});

onBeforeUnmount(() => {
  alive = false;
  clearTimer();
});
</script>

<template>
  <section>
    <h1>Experiments</h1>

    <div v-if="listError" class="error" data-test="list-error">
      <div>Could not load the experiments: {{ listError.message }}</div>
      <ul v-if="listError.reasons.length">
        <li v-for="r in listError.reasons" :key="r">{{ r }}</li>
      </ul>
    </div>
    <p v-if="experiments === null && !listError" class="muted">Loading experiments...</p>
    <p v-else-if="experiments !== null && experiments.length === 0" class="muted">No experiments yet. Use the form below to create the first.</p>

    <table v-if="experiments && experiments.length" class="experiments">
      <thead>
        <tr>
          <th>Name</th>
          <th>Status</th>
          <th>Progress</th>
          <th class="num">Trials per cell</th>
          <th>Phase</th>
          <th>Axis</th>
          <th>Hypothesis</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="e in experiments" :key="e.id" :data-experiment="e.id">
          <td>
            <RouterLink :to="`/experiments/${e.id}`">{{ e.name }}</RouterLink>
          </td>
          <td>
            <StatusChip :status="e.status" />
            <StatusChip v-if="e.paused" status="paused" :title="e.pause_reason ?? ''" />
          </td>
          <td>
            <div class="counts">{{ counts(e) }}</div>
            <progress :value="finished(e)" :max="e.progress.total || 1" :aria-label="`progress of ${e.name}`" />
          </td>
          <td class="num">{{ e.n_trials }}</td>
          <td>{{ e.phase }}</td>
          <td>{{ e.axis ?? '' }}</td>
          <td class="hypothesis" :title="e.hypothesis ?? ''">{{ shortHypothesis(e.hypothesis) }}</td>
          <td class="small">{{ when(e.created_at) }}</td>
        </tr>
      </tbody>
    </table>

    <h2>New experiment</h2>
    <div v-if="loadError" class="error" data-test="load-error">
      <div>Could not load the configs or tasks: {{ loadError.message }}</div>
      <ul v-if="loadError.reasons.length">
        <li v-for="r in loadError.reasons" :key="r">{{ r }}</li>
      </ul>
    </div>

    <form class="form-grid" novalidate @submit.prevent="submit">
      <label for="exp-name">Name</label>
      <div><input id="exp-name" v-model="name" type="text" required /></div>

      <label>Configs</label>
      <div>
        <p v-if="configs.length === 0" class="muted">No configs yet. Create 2 on the Configs page first.</p>
        <div v-for="c in configs" :key="c.id" class="check config-option">
          <label>
            <input type="checkbox" :value="c.id" :checked="checkedConfigs.includes(c.id)" @change="toggleConfig(c.id, ($event.target as HTMLInputElement).checked)" />
            <strong>{{ c.name }}</strong>
            <span class="muted">
              {{ c.harness_id }}@{{ c.harness_version }}, {{ c.model_slug }},
              <span class="mono">{{ hashPrefix(c.config_hash) }}</span>
            </span>
            <span v-if="orderOf(c.id)" class="badge order">#{{ orderOf(c.id) }}</span>
          </label>
        </div>
        <p class="muted small">Check at least 2. The order you check them in is the order they are sent.</p>
      </div>

      <label>Tasks</label>
      <div>
        <div class="row">
          <button type="button" data-test="tasks-all" @click="selectAllTasks">Select all</button>
          <button type="button" data-test="tasks-none" @click="selectNoTasks">Select none</button>
          <span class="muted small" data-test="task-count">{{ checkedTasks.length }} of {{ tasks.length }} tasks checked</span>
        </div>
        <div v-for="g in taskGroups" :key="g.category" class="task-group">
          <h3>{{ g.category }} ({{ g.tasks.length }})</h3>
          <div v-for="t in g.tasks" :key="t.id" class="check task-option">
            <label>
              <input type="checkbox" :value="t.id" :checked="checkedTasks.includes(t.id)" @change="toggleTask(t.id, ($event.target as HTMLInputElement).checked)" />
              <span class="mono">{{ t.id }}</span>
              <span class="muted small mono">{{ hashPrefix(t.version_hash) }}</span>
            </label>
          </div>
        </div>
      </div>

      <label for="exp-n">N (trials per cell)</label>
      <div><input id="exp-n" v-model="nTrials" type="number" min="1" step="1" /></div>

      <label for="exp-seed">Seed</label>
      <div>
        <input id="exp-seed" v-model="seed" type="text" inputmode="numeric" placeholder="optional" />
        <span class="muted small"> Leave empty and the API picks a seed; it is recorded on the experiment.</span>
      </div>

      <label for="exp-axis">Axis</label>
      <div><input id="exp-axis" v-model="axis" type="text" placeholder="optional, e.g. memory off vs seeded" /></div>

      <label for="exp-hypothesis">Hypothesis</label>
      <div>
        <textarea id="exp-hypothesis" v-model="hypothesis" required />
        <div class="muted small">Required. It is pre-registered: it cannot be changed after the experiment leaves draft.</div>
      </div>

      <label for="exp-phase">Phase</label>
      <div>
        <select id="exp-phase" v-model="phase">
          <option value="pilot">pilot</option>
          <option value="full">full</option>
        </select>
      </div>

      <span />
      <div>
        <button type="submit" class="primary" :disabled="submitting" data-test="submit">{{ submitting ? 'Creating...' : 'Create experiment' }}</button>
      </div>
    </form>

    <div v-if="problems.length" class="error" data-test="form-problems">
      <div>The experiment was not created:</div>
      <ul>
        <li v-for="p in problems" :key="p">{{ p }}</li>
      </ul>
    </div>
    <div v-if="submitError" class="error" data-test="submit-error">
      <div>{{ submitError.message }}</div>
      <ul v-if="submitError.reasons.length">
        <li v-for="r in submitError.reasons" :key="r">{{ r }}</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.counts { font-size: 12px; margin-bottom: 2px; }
progress { width: 160px; height: 8px; }
.hypothesis { max-width: 320px; }
.check label { font-weight: normal; display: flex; gap: 6px; align-items: baseline; padding: 1px 0; }
.task-group h3 { margin: 10px 0 2px; }
</style>
