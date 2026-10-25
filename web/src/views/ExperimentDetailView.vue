<script setup lang="ts">
// Experiment detail: header, actions, trials table with client-side filters, compare picker, exports and the pilot panel
// (cards/P4.md section 6, S2). Polls GET /experiments/:id every 3 s while the status is queued or running.
// The pilot panel renders variance and projected widths only. Nothing here computes a statistic.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api, ApiError } from '../api/client';
import type { ExperimentDetail, PilotPayload, TrialRow, TrialStatus } from '../api/types';
import StatusChip from '../components/StatusChip.vue';
import { hashPrefix, int, num, seconds, shortId, usd, when } from '../lib/format';

const props = defineProps<{ id: string }>();

const POLL_MS = 3000;
const TRIAL_STATUSES: TrialStatus[] = ['pending', 'running', 'done', 'errored', 'cancelled'];

interface Shown {
  message: string;
  reasons: string[];
}
const shown = (e: unknown): Shown =>
  e instanceof ApiError ? { message: e.message, reasons: e.reasons } : { message: e instanceof Error ? e.message : String(e), reasons: [] };

const router = useRouter();

const exp = ref<ExperimentDetail | null>(null);
const trials = ref<TrialRow[] | null>(null);
const pilot = ref<PilotPayload | null>(null);
const loadError = ref<Shown | null>(null);
const trialsError = ref<Shown | null>(null);
const pilotError = ref<Shown | null>(null);
const actionError = ref<Shown | null>(null);
const actionResult = ref('');
const busy = ref(false);

let alive = true;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
let pilotSeq = 0;

const status = computed(() => exp.value?.status ?? null);
const isActive = computed(() => status.value === 'queued' || status.value === 'running');

// ------------------------------------------------------------------ loading and polling

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function schedule(): void {
  clearTimer();
  if (alive && isActive.value) timer = setTimeout(tick, POLL_MS);
}

async function load(): Promise<void> {
  const id = props.id;
  const [e, t] = await Promise.allSettled([api.getExperiment(id), api.listTrials(id)]);
  if (!alive || id !== props.id) return;
  if (e.status === 'fulfilled') {
    exp.value = e.value;
    loadError.value = null;
  } else {
    loadError.value = shown(e.reason);
  }
  if (t.status === 'fulfilled') {
    trials.value = t.value;
    trialsError.value = null;
  } else {
    trialsError.value = shown(t.reason);
  }
}

async function refresh(): Promise<void> {
  if (inflight) await inflight;
  const p = load().finally(() => {
    if (inflight === p) inflight = null;
  });
  inflight = p;
  await p;
  schedule();
}

/** A poll tick never stacks on a request that is still in flight: it skips and tries again after the interval. */
async function tick(): Promise<void> {
  timer = null;
  if (inflight) {
    schedule();
    return;
  }
  await refresh();
}

async function loadPilot(): Promise<void> {
  const seq = ++pilotSeq;
  try {
    const p = await api.pilot(props.id);
    if (!alive || seq !== pilotSeq) return;
    pilot.value = p;
    pilotError.value = null;
  } catch (e) {
    if (!alive || seq !== pilotSeq) return;
    pilotError.value = shown(e);
  }
}

// The pilot is read on load and again whenever the finished count, the status or n_trials changes.
// n_trials is a source too: Extend on a draft changes it without changing the status or the finished count, and n_pilot follows it.
watch([() => exp.value?.progress.done, () => exp.value?.status, () => exp.value?.n_trials], () => {
  void loadPilot();
});

void refresh();

// The same instance can be reused for another experiment id (router.push to a reproduced draft in tests, or a param change).
watch(
  () => props.id,
  () => {
    clearTimer();
    exp.value = trials.value = pilot.value = null;
    loadError.value = trialsError.value = pilotError.value = actionError.value = null;
    actionResult.value = '';
    pilotSeq++;
    void refresh();
  },
);

onBeforeUnmount(() => {
  alive = false;
  clearTimer();
});

// ------------------------------------------------------------------ actions

// An <input type="number"> hands v-model a number (or '' when empty), so the ref holds either.
const extendTo = ref<number | string>('');
watch(
  () => exp.value?.n_trials,
  (n) => {
    if (n !== undefined) extendTo.value = n + 1;
  },
  { immediate: true },
);

const extendValue = computed(() => {
  const text = String(extendTo.value).trim();
  return /^\d+$/.test(text) ? Number(text) : null;
});
const canStart = computed(() => status.value === 'draft');
const canCancel = computed(() => status.value === 'draft' || status.value === 'queued' || status.value === 'running');
const canExtend = computed(
  () => exp.value !== null && status.value !== 'cancelled' && extendValue.value !== null && extendValue.value > exp.value.n_trials,
);

async function act(label: string, run: () => Promise<ExperimentDetail>, after?: (r: ExperimentDetail) => Promise<void>): Promise<void> {
  busy.value = true;
  actionError.value = null;
  actionResult.value = '';
  try {
    const r = await run();
    actionResult.value = `${label}: done. Status is ${r.status}${r.paused ? ' (paused)' : ''}, ${r.n_trials} trials per cell.`;
    if (after) {
      await after(r);
      return;
    }
    await refresh();
  } catch (e) {
    const err = shown(e);
    actionError.value = { message: `${label} failed: ${err.message}`, reasons: err.reasons };
  } finally {
    busy.value = false;
  }
}

const start = (): Promise<void> => act('Start', () => api.startExperiment(props.id));
const cancel = (): Promise<void> => act('Cancel', () => api.cancelExperiment(props.id));
const resume = (): Promise<void> => act('Resume', () => api.resumeExperiment(props.id));
const extend = (): Promise<void> => {
  const n = extendValue.value;
  if (n === null) return Promise.resolve();
  return act('Extend', () => api.extendExperiment(props.id, n));
};
const reproduce = (): Promise<void> =>
  act(
    'Reproduce',
    () => api.reproduceExperiment(props.id),
    async (r) => {
      await router.push(`/experiments/${r.id}`);
    },
  );

// ------------------------------------------------------------------ trials table and filters

// Config names are not unique, so a name that is shared inside this experiment gets position, harness and model appended.
const configLabels = computed(() => {
  const list = exp.value?.configs ?? [];
  const taken = new Map<string, number>();
  for (const c of list) taken.set(c.name, (taken.get(c.name) ?? 0) + 1);
  return new Map(
    list.map((c) => [c.id, (taken.get(c.name) ?? 0) > 1 ? `${c.name} (#${c.position + 1}, ${c.harness_id}, ${c.model_slug})` : c.name] as const),
  );
});
const configName = (id: string): string => configLabels.value.get(id) ?? shortId(id);

const configFilter = ref('');
const taskFilter = ref('');
const statusFilter = ref('');
const passedFilter = ref<'' | 'passed' | 'failed'>('');

const sortedConfigs = computed(() => [...(exp.value?.configs ?? [])].sort((a, b) => a.position - b.position));
const taskOptions = computed(() => {
  const ids = new Set<string>((exp.value?.tasks ?? []).map((t) => t.task_id));
  for (const t of trials.value ?? []) ids.add(t.task_id);
  return [...ids];
});

const visibleTrials = computed(() =>
  (trials.value ?? []).filter(
    (t) =>
      (!configFilter.value || t.config_id === configFilter.value) &&
      (!taskFilter.value || t.task_id === taskFilter.value) &&
      (!statusFilter.value || t.status === statusFilter.value) &&
      (passedFilter.value === '' || (passedFilter.value === 'passed' ? t.passed === true : t.passed === false)),
  ),
);

const passedText = (p: boolean | null): string => (p === true ? 'PASS' : p === false ? 'FAIL' : '-');
const passedClass = (p: boolean | null): string => (p === true ? 'pass' : p === false ? 'fail' : 'muted');

function counts(e: ExperimentDetail): string {
  const p = e.progress;
  const parts = [`done ${p.done}`, `errored ${p.errored}`, `pending ${p.pending}`, `running ${p.running}`];
  if (p.cancelled > 0) parts.push(`cancelled ${p.cancelled}`);
  return `${parts.join(', ')} of ${p.total}`;
}

// ------------------------------------------------------------------ compare and exports

const pickA = ref('');
const pickB = ref('');
watch(
  sortedConfigs,
  (list) => {
    const ids = list.map((c) => c.id);
    if (!ids.includes(pickA.value)) pickA.value = ids[0] ?? '';
    if (!ids.includes(pickB.value)) pickB.value = ids[1] ?? '';
  },
  { immediate: true },
);
const canCompare = computed(() => sortedConfigs.value.length >= 2 && pickA.value !== '' && pickB.value !== '' && pickA.value !== pickB.value);
</script>

<template>
  <section>
    <p><RouterLink to="/experiments">All experiments</RouterLink></p>

    <div v-if="loadError" class="error" data-test="load-error">
      <div>Could not load the experiment: {{ loadError.message }}</div>
      <ul v-if="loadError.reasons.length">
        <li v-for="r in loadError.reasons" :key="r">{{ r }}</li>
      </ul>
    </div>
    <p v-if="!exp && !loadError" class="muted">Loading experiment...</p>

    <template v-if="exp">
      <header class="head">
        <h1>
          {{ exp.name }}
          <StatusChip :status="exp.status" />
          <StatusChip v-if="exp.paused" status="paused" />
        </h1>
        <div v-if="exp.paused" class="warn" data-test="paused">
          Paused: {{ exp.pause_reason ?? 'no reason recorded' }}
          <button type="button" data-test="resume" :disabled="busy" @click="resume">Resume</button>
        </div>

        <div class="card hypothesis" data-test="hypothesis">
          <div class="small muted">Hypothesis (pre-registered)</div>
          <div class="hypothesis-text">{{ exp.hypothesis ?? 'No hypothesis was recorded.' }}</div>
        </div>
        <p data-test="axis"><strong>Axis:</strong> {{ exp.axis ?? 'none' }}</p>

        <dl class="meta">
          <dt>Phase</dt><dd>{{ exp.phase }}</dd>
          <dt>Trials per cell</dt><dd>{{ exp.n_trials }}</dd>
          <dt>Seed</dt><dd>{{ exp.seed }}</dd>
          <dt>Created</dt><dd>{{ when(exp.created_at) }}</dd>
          <dt>Started</dt><dd>{{ when(exp.started_at) }}</dd>
          <dt>Finished</dt><dd>{{ when(exp.finished_at) }}</dd>
          <dt>Progress</dt>
          <dd>
            <span data-test="counts">{{ counts(exp) }}</span>
            <progress :value="exp.progress.done + exp.progress.errored + exp.progress.cancelled" :max="exp.progress.total || 1" />
          </dd>
        </dl>
      </header>

      <h2>Actions</h2>
      <div class="row">
        <button type="button" class="primary" data-test="start" :disabled="busy || !canStart" @click="start">Start</button>
        <button type="button" data-test="cancel" :disabled="busy || !canCancel" @click="cancel">Cancel</button>
        <span class="row">
          <label for="extend-to">Extend to N</label>
          <input id="extend-to" v-model="extendTo" type="number" min="1" step="1" style="width: 80px" />
          <button type="button" data-test="extend" :disabled="busy || !canExtend" @click="extend">Extend</button>
        </span>
        <button type="button" data-test="reproduce" :disabled="busy" @click="reproduce">Reproduce</button>
      </div>
      <div v-if="actionResult" class="notice" data-test="action-result">{{ actionResult }}</div>
      <div v-if="actionError" class="error" data-test="action-error">
        <div>{{ actionError.message }}</div>
        <ul v-if="actionError.reasons.length">
          <li v-for="r in actionError.reasons" :key="r">{{ r }}</li>
        </ul>
      </div>

      <h2>Compare and export</h2>
      <div class="row">
        <label for="pick-a">A</label>
        <select id="pick-a" v-model="pickA">
          <option v-for="c in sortedConfigs" :key="c.id" :value="c.id">{{ configName(c.id) }}</option>
        </select>
        <label for="pick-b">B</label>
        <select id="pick-b" v-model="pickB">
          <option v-for="c in sortedConfigs" :key="c.id" :value="c.id">{{ configName(c.id) }}</option>
        </select>
        <RouterLink v-if="canCompare" data-test="compare" :to="{ name: 'compare', params: { id: exp.id }, query: { a: pickA, b: pickB } }">Compare</RouterLink>
        <button v-else type="button" data-test="compare" disabled>Compare</button>
        <a data-test="export-json" :href="api.exportJsonUrl(exp.id)" download>Export JSON</a>
        <a data-test="export-csv" :href="api.exportCsvUrl(exp.id)" download>Export CSV</a>
        <a v-if="canCompare" data-test="compare-csv" :href="api.compareCsvUrl(exp.id, pickA, pickB)" download>Compare CSV</a>
        <button v-else type="button" data-test="compare-csv" disabled>Compare CSV</button>
      </div>
      <p v-if="sortedConfigs.length >= 2 && pickA === pickB" class="muted small">Pick 2 different configs to compare.</p>

      <h2>Trials</h2>
      <div v-if="trialsError" class="error" data-test="trials-error">
        <div>Could not load the trials: {{ trialsError.message }}</div>
        <ul v-if="trialsError.reasons.length">
          <li v-for="r in trialsError.reasons" :key="r">{{ r }}</li>
        </ul>
      </div>
      <div class="row filters">
        <label>
          Config
          <select v-model="configFilter" data-test="filter-config">
            <option value="">all</option>
            <option v-for="c in sortedConfigs" :key="c.id" :value="c.id">{{ configName(c.id) }}</option>
          </select>
        </label>
        <label>
          Task
          <select v-model="taskFilter" data-test="filter-task">
            <option value="">all</option>
            <option v-for="t in taskOptions" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <label>
          Status
          <select v-model="statusFilter" data-test="filter-status">
            <option value="">all</option>
            <option v-for="s in TRIAL_STATUSES" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label>
          Passed
          <select v-model="passedFilter" data-test="filter-passed">
            <option value="">all</option>
            <option value="passed">passed</option>
            <option value="failed">failed</option>
          </select>
        </label>
        <span class="muted" data-test="showing">showing {{ visibleTrials.length }} of {{ trials ? trials.length : 0 }} trials</span>
      </div>
      <table class="trials">
        <thead>
          <tr>
            <th>Config</th>
            <th>Task</th>
            <th class="num">Index</th>
            <th>Status</th>
            <th>Passed</th>
            <th>Exit reason</th>
            <th class="num">Steps</th>
            <th class="num">Cost</th>
            <th class="num">Latency</th>
            <th class="num">Rate limit events</th>
            <th>Error class</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in visibleTrials" :key="t.id" :data-trial="t.id">
            <td>{{ configName(t.config_id) }}</td>
            <td><RouterLink :to="`/trials/${t.id}`">{{ t.task_id }}</RouterLink></td>
            <td class="num"><RouterLink :to="`/trials/${t.id}`">{{ t.trial_index }}</RouterLink></td>
            <td><StatusChip :status="t.status" /></td>
            <td :class="passedClass(t.passed)">{{ passedText(t.passed) }}</td>
            <td>{{ t.exit_reason ?? '' }}</td>
            <td class="num">{{ int(t.steps) }}</td>
            <td class="num">{{ usd(t.cost_usd) }}</td>
            <td class="num">{{ seconds(t.latency_ms) }}</td>
            <td class="num">{{ t.rate_limit_events }}</td>
            <td>{{ t.error_class ?? '' }}</td>
          </tr>
          <tr v-if="visibleTrials.length === 0">
            <td colspan="11" class="muted">{{ trials === null ? 'Loading trials...' : 'No trials match.' }}</td>
          </tr>
        </tbody>
      </table>

      <details class="pinned" data-test="pinned-tasks">
        <summary>Tasks pinned to this experiment ({{ exp.tasks.length }})</summary>
        <table>
          <thead>
            <tr><th>Task</th><th>Category</th><th>Version hash</th></tr>
          </thead>
          <tbody>
            <tr v-for="t in exp.tasks" :key="t.task_id">
              <td>{{ t.task_id }}</td>
              <td>{{ t.category }}</td>
              <td class="mono">{{ hashPrefix(t.task_version_hash) }}</td>
            </tr>
          </tbody>
        </table>
      </details>

      <h2>Pilot</h2>
      <div class="pilot" data-test="pilot">
        <p class="muted small">Variance and projected interval widths only, to help choose N. This panel shows no comparison of the configs.</p>
        <div v-if="pilotError" class="error" data-test="pilot-error">
          <div>Could not load the pilot: {{ pilotError.message }}</div>
          <ul v-if="pilotError.reasons.length">
            <li v-for="r in pilotError.reasons" :key="r">{{ r }}</li>
          </ul>
        </div>
        <p v-if="!pilot && !pilotError" class="muted">Loading pilot...</p>
        <template v-if="pilot">
          <div v-if="!pilot.ready" class="warn" data-test="pilot-reason">Not ready: {{ pilot.reason ?? 'no reason given' }}</div>
          <dl class="meta">
            <dt>Ready</dt><dd>{{ pilot.ready ? 'yes' : 'no' }}</dd>
            <dt>Pilot trials per cell</dt><dd>{{ pilot.n_pilot }}</dd>
            <dt>Tasks</dt><dd>{{ pilot.n_tasks }}</dd>
            <dt>Judged tasks</dt><dd>{{ pilot.n_judged_tasks }}</dd>
            <dt>Configs</dt><dd>{{ pilot.n_configs }}</dd>
            <dt>Within-task variance</dt><dd>{{ num(pilot.within_task_variance, 4) }}</dd>
            <dt>Bernoulli bound variance</dt><dd>{{ num(pilot.bernoulli_bound_variance, 4) }}</dd>
            <dt>Target half-width</dt><dd>{{ num(pilot.target_half_width, 3) }}</dd>
            <dt>N cap</dt><dd>{{ pilot.n_cap }}</dd>
            <dt>Recommended N</dt><dd>{{ pilot.recommended_n === null ? 'none' : pilot.recommended_n }}</dd>
            <dt>Capped</dt><dd>{{ pilot.capped ? 'yes' : 'no' }}</dd>
          </dl>
          <p v-if="pilot.recommendation_reason" data-test="pilot-recommendation">{{ pilot.recommendation_reason }}</p>
          <table v-if="pilot.projections.length" class="projections">
            <thead>
              <tr>
                <th class="num">N</th>
                <th class="num">Half-width observed</th>
                <th class="num">Half-width observed without judged</th>
                <th class="num">Half-width bound</th>
                <th class="num">Trials total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in pilot.projections" :key="p.n">
                <td class="num">{{ p.n }}</td>
                <td class="num">{{ num(p.half_width_observed) }}</td>
                <td class="num">{{ num(p.half_width_observed_without_judged) }}</td>
                <td class="num">{{ num(p.half_width_bound) }}</td>
                <td class="num">{{ p.trials_total }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </div>
    </template>
  </section>
</template>

<style scoped>
.hypothesis { margin: 10px 0; border-left: 4px solid var(--link); }
.hypothesis-text { font-size: 15px; white-space: pre-wrap; }
.meta { display: grid; grid-template-columns: 200px 1fr; gap: 2px 12px; margin: 8px 0; max-width: 760px; }
.meta dt { color: var(--muted); }
.meta dd { margin: 0; }
.filters label { display: inline-flex; gap: 4px; align-items: center; }
progress { width: 160px; height: 8px; margin-left: 8px; }
.pinned { margin: 12px 0; }
.pilot table { max-width: 760px; }
</style>
