<script setup lang="ts">
// The trial inspector (cards/P4.md section 5): a reader must be able to say why a trial failed from this page alone.
// Nothing here decides pass or fail or computes a statistic: every verdict comes from the API's grader results, and
// the "why it failed" lines only restate those results in words. Trace text is untrusted and is never rendered as HTML.
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ApiError, api } from '../api/client';
import type { ExperimentDetail, FailureEvidence, FullTrace, GraderResult, PartialTrace, Task, Trace, TraceEvent as TraceEv, Trial } from '../api/types';
import GraderDetail from '../components/GraderDetail.vue';
import StatusChip from '../components/StatusChip.vue';
import TraceEvent from '../components/TraceEvent.vue';
import { FAILURE_RULE } from '../lib/failures';
import { int, seconds, shortId, usd, when } from '../lib/format';
import { useAppStore } from '../stores/app';

const props = defineProps<{ id: string }>();
const store = useAppStore();

// ---------------------------------------------------------------- loading

interface Failure {
  message: string;
  reasons: string[];
}
const toFailure = (e: unknown): Failure =>
  e instanceof ApiError ? { message: e.message, reasons: e.reasons } : { message: e instanceof Error ? e.message : String(e), reasons: [] };

const trial = ref<Trial | null>(null);
const trace = ref<Trace | null>(null);
const experiment = ref<ExperimentDetail | null>(null);
const loading = ref(true);
const trialError = ref<Failure | null>(null);
const traceError = ref<Failure | null>(null);
const experimentError = ref<Failure | null>(null);
const tasksError = ref<Failure | null>(null);
const registryTask = ref<Task | null>(null);
const tasksChecked = ref(false);

let token = 0;
let alive = true;
onBeforeUnmount(() => {
  alive = false;
});

function resetState(): void {
  trial.value = null;
  trace.value = null;
  experiment.value = null;
  trialError.value = null;
  traceError.value = null;
  experimentError.value = null;
  tasksError.value = null;
  registryTask.value = null;
  tasksChecked.value = false;
  expanded.clear();
  disabledKinds.clear();
  offset.value = 0;
  focusedSeq.value = null;
}

async function load(id: string): Promise<void> {
  const mine = ++token;
  loading.value = true;
  resetState();
  const [t, tr] = await Promise.allSettled([api.getTrial(id), api.getTrace(id)]);
  if (!alive || mine !== token) return;
  if (t.status === 'rejected') {
    trialError.value = toFailure(t.reason);
    loading.value = false;
    return;
  }
  trial.value = t.value;
  if (tr.status === 'fulfilled') trace.value = tr.value;
  else traceError.value = toFailure(tr.reason);
  loading.value = false;

  const needTasks = !userPrompt.value;
  const [exp, tasks] = await Promise.allSettled([
    api.getExperiment(t.value.experiment_id),
    needTasks ? store.loadTasks() : Promise.resolve<Task[]>([]),
  ]);
  if (!alive || mine !== token) return;
  if (exp.status === 'fulfilled') experiment.value = exp.value;
  else experimentError.value = toFailure(exp.reason);
  if (needTasks) {
    tasksChecked.value = true;
    if (tasks.status === 'fulfilled') {
      // Only a task whose version hash equals the trial's is the prompt the agent saw.
      registryTask.value = tasks.value.find((x) => x.id === t.value.task_id && x.version_hash === t.value.task_version_hash) ?? null;
    } else tasksError.value = toFailure(tasks.reason);
  }
}

// ---------------------------------------------------------------- derived data

const fullTrace = computed<FullTrace | null>(() => (trace.value && !trace.value.partial ? trace.value : null));
const partialTrace = computed<PartialTrace | null>(() => (trace.value && trace.value.partial === true ? trace.value : null));

const events = computed<TraceEv[]>(() => [...(trace.value?.events ?? [])].sort((a, b) => a.seq - b.seq));

const graderResults = computed<GraderResult[]>(() => {
  const own = trial.value?.grader_results ?? [];
  const list = own.length ? own : (trace.value?.grader_results ?? []);
  return [...list].sort((a, b) => a.grader_index - b.grader_index);
});

const configName = computed(() => {
  const t = trial.value;
  if (!t) return '';
  return experiment.value?.configs.find((c) => c.id === t.config_id)?.name ?? `config ${shortId(t.config_id)}`;
});

/** Exactly what the agent saw: the content of the first user message event. */
const userPromptEvent = computed(() => {
  for (const e of events.value) if (e.kind === 'message' && e.role === 'user') return e;
  return null;
});
const userPrompt = computed<string | null>(() => userPromptEvent.value?.content ?? null);
/** The runner truncates long event strings and flags it; the prompt must not look complete when it is not. */
const promptTruncation = computed(() => {
  const e = userPromptEvent.value;
  if (!e || !e.truncated) return null;
  return `truncated, original length ${e.orig_len ?? 'unknown'} characters`;
});

const promptText = computed(() => userPrompt.value ?? registryTask.value?.prompt ?? null);
const promptSource = computed(() =>
  userPrompt.value !== null ? 'the first user message of the trace' : registryTask.value ? 'the task registry (same version hash as this trial)' : '',
);

const systemPrompt = computed<string | null>(() => {
  const t = fullTrace.value;
  if (!t) return null;
  if (t.system_prompt !== null && t.system_prompt !== undefined) return t.system_prompt;
  for (const e of events.value) if (e.kind === 'message' && e.role === 'system') return e.content;
  return null;
});

// ---------------------------------------------------------------- why it failed (restates grader results, never decides)

interface WhyItem {
  key: number;
  type: string;
  lines: string[];
  reasoning: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const word = (v: unknown): string => (typeof v === 'string' ? (v === '' ? '(empty string)' : v) : (JSON.stringify(v) ?? String(v)));

function lastLine(output: unknown): string {
  if (typeof output !== 'string') return '(no output recorded)';
  const lines = output.split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.length ? lines[lines.length - 1] : '(no output)';
}

const reasonOf = (o: Obj): string => (typeof o.reason === 'string' && o.reason !== '' ? o.reason : '(no reason recorded)');

function whyFor(g: GraderResult): WhyItem {
  const d = isObj(g.details) ? g.details : null;
  const item: WhyItem = { key: g.grader_index, type: g.grader_type, lines: [], reasoning: null };
  if (g.grader_type === 'exact_match' && d && 'expected' in d && 'extracted' in d) {
    // The grader records a reason when it had nothing to compare (for example "no final response").
    const why = typeof d.reason === 'string' && d.reason !== '' ? ` (grader reason: ${d.reason})` : '';
    item.lines.push(`expected ${word(d.expected)} but the extracted answer was ${word(d.extracted)}${why}`);
    if (d.used_fallback === true) item.lines.push('no FINAL line was found in the response, so the fallback extraction was used');
  } else if (g.grader_type === 'file_state' && d && Array.isArray(d.checks)) {
    const bad = objs(d.checks).filter((c) => c.passed !== true);
    for (const c of bad) item.lines.push(`file check failed: ${reasonOf(c)} (check ${word(c.check)})`);
    if (!bad.length) item.lines.push('no individual check is marked failed in the recorded details');
  } else if (g.grader_type === 'unit_test' && d && 'command' in d) {
    const how = d.timed_out === true ? 'timed out' : `exited with code ${word(d.exit_code)}`;
    item.lines.push(`the command ${word(d.command)} ${how}; last line of its output: ${lastLine(d.output)}`);
  } else if (g.grader_type === 'trace_check' && d && Array.isArray(d.assertions)) {
    const bad = objs(d.assertions).filter((a) => a.passed !== true);
    for (const a of bad) item.lines.push(`trace assertion failed: ${reasonOf(a)} (assertion ${word(a.assertion)})`);
    if (!bad.length) item.lines.push('no individual assertion is marked failed in the recorded details');
  } else if (g.grader_type === 'llm_judge' && d && Array.isArray(d.criteria)) {
    const unmet = objs(d.criteria).filter((c) => c.met !== true);
    for (const c of unmet) {
      const ev = typeof c.evidence === 'string' && c.evidence !== '' ? `: ${c.evidence}` : '';
      item.lines.push(`criterion ${word(c.id)} was not met${ev}`);
    }
    if (!unmet.length) item.lines.push('the judge marked no criterion as unmet; see its reasoning');
    item.reasoning = g.reasoning;
  } else {
    item.lines.push(`${g.grader_type} did not pass; recorded details: ${d ? word(d) : 'none'}`);
    item.reasoning = g.reasoning;
  }
  return item;
}

const whyItems = computed<WhyItem[]>(() => graderResults.value.filter((g) => !g.passed).map(whyFor));

const whyNoGrader = computed(() => {
  const t = trial.value;
  if (!t || graderResults.value.length) return '';
  if (t.error_class || t.error_message || partialTrace.value?.error_class || partialTrace.value?.error_message) {
    const cls = t.error_class ?? partialTrace.value?.error_class ?? 'none';
    const msg = t.error_message ?? partialTrace.value?.error_message ?? 'none';
    return `no grader result was recorded for this trial. It ended with error class ${cls}; message: ${msg}`;
  }
  return 'no grader result was recorded for this trial, and no error class or message is recorded either';
});

// ---------------------------------------------------------------- timeline

const KIND_ORDER: TraceEv['kind'][] = ['message', 'tool_call', 'tool_result', 'api_call', 'memory_read', 'memory_write', 'skill_invoked', 'error'];
const KIND_LABEL: Record<TraceEv['kind'], string> = {
  message: 'MESSAGE',
  tool_call: 'TOOL CALL',
  tool_result: 'TOOL RESULT',
  api_call: 'API CALL',
  memory_read: 'MEMORY READ',
  memory_write: 'MEMORY WRITE',
  skill_invoked: 'SKILL',
  error: 'ERROR',
};
const WINDOW_THRESHOLD = 500;
const WINDOW_SIZE = 200;

const kindCounts = computed(() => {
  const counts: Record<string, number> = {};
  for (const e of events.value) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return KIND_ORDER.filter((k) => counts[k]).map((k) => ({ kind: k, label: KIND_LABEL[k], count: counts[k] }));
});

const disabledKinds = reactive(new Set<string>());
const expanded = reactive(new Set<number>());
const offset = ref(0);
const focusedSeq = ref<number | null>(null);
const root = ref<HTMLElement | null>(null);

const filtered = computed(() => events.value.filter((e) => !disabledKinds.has(e.kind)));
const windowed = computed(() => filtered.value.length > WINDOW_THRESHOLD);
const windowStart = computed(() => {
  if (!windowed.value) return 0;
  const last = Math.floor((filtered.value.length - 1) / WINDOW_SIZE) * WINDOW_SIZE;
  return Math.min(offset.value, last);
});
const visible = computed(() => (windowed.value ? filtered.value.slice(windowStart.value, windowStart.value + WINDOW_SIZE) : filtered.value));
const windowText = computed(
  () => `events ${windowStart.value + 1}-${Math.min(windowStart.value + WINDOW_SIZE, filtered.value.length)} of ${filtered.value.length}`,
);

/** call_id pairing over ALL events, so a filter never breaks the link between a call and its result. */
const callsById = computed(() => {
  const m = new Map<string, TraceEv>();
  for (const e of events.value) if (e.kind === 'tool_call' && !m.has(e.call_id)) m.set(e.call_id, e);
  return m;
});
const resultsById = computed(() => {
  const m = new Map<string, TraceEv>();
  for (const e of events.value) if (e.kind === 'tool_result' && !m.has(e.call_id)) m.set(e.call_id, e);
  return m;
});
function pairedWith(e: TraceEv): TraceEv | null {
  if (e.kind === 'tool_call') return resultsById.value.get(e.call_id) ?? null;
  if (e.kind === 'tool_result') return callsById.value.get(e.call_id) ?? null;
  return null;
}

function toggle(seq: number): void {
  if (expanded.has(seq)) expanded.delete(seq);
  else expanded.add(seq);
}
function expandAll(): void {
  for (const e of filtered.value) expanded.add(e.seq);
}
function collapseAll(): void {
  expanded.clear();
}
function setKind(kind: string, on: boolean): void {
  if (on) disabledKinds.delete(kind);
  else disabledKinds.add(kind);
  offset.value = 0;
}
function prev(): void {
  offset.value = Math.max(0, windowStart.value - WINDOW_SIZE);
}
function next(): void {
  if (windowStart.value + WINDOW_SIZE < filtered.value.length) offset.value = windowStart.value + WINDOW_SIZE;
}

// ---------------------------------------------------------------- failure category (the API's rules; this only displays them and follows their links)

const evidence = computed<FailureEvidence | null>(() => trial.value?.failure_evidence ?? null);
const eventExists = (seq: number): boolean => events.value.some((e) => e.seq === seq);

/**
 * Brings the event the evidence names into view: re-enables its kind if a filter hid it, pages the window onto it, expands it, scrolls
 * to it and outlines it. The row is found by its seq, never by its position, so a filter or a window cannot make the link land elsewhere.
 */
async function goToEvent(seq: number): Promise<void> {
  const ev = events.value.find((e) => e.seq === seq);
  if (!ev) return;
  disabledKinds.delete(ev.kind);
  const at = filtered.value.findIndex((e) => e.seq === seq);
  if (windowed.value && at >= 0) offset.value = Math.floor(at / WINDOW_SIZE) * WINDOW_SIZE;
  expanded.add(seq);
  focusedSeq.value = seq;
  await nextTick();
  root.value?.querySelector(`#event-${seq}`)?.scrollIntoView?.({ block: 'center' });
}

async function goToGrader(index: number): Promise<void> {
  await nextTick();
  root.value?.querySelector(`[data-grader-index="${index}"]`)?.scrollIntoView?.({ block: 'center' });
}

// ---------------------------------------------------------------- memory

const memoryFiles = computed(() => {
  const t = fullTrace.value;
  if (!t) return [];
  const names = new Set([...Object.keys(t.memory_initial ?? {}), ...Object.keys(t.memory_final ?? {})]);
  return [...names].sort().map((name) => {
    const before = t.memory_initial?.[name];
    const after = t.memory_final?.[name];
    return { name, before, after, differs: before !== after };
  });
});
const memoryChanged = computed(() => memoryFiles.value.some((f) => f.differs));

// Last, so every ref the loader resets exists before the immediate first run.
watch(() => props.id, (id) => void load(id), { immediate: true });
</script>

<template>
  <div ref="root" class="trial-view">
    <p v-if="loading" class="muted">Loading trial...</p>

    <div v-else-if="trialError" class="error" role="alert" data-test="trial-error">
      <strong>Could not load trial {{ id }}: {{ trialError.message }}</strong>
      <ul v-if="trialError.reasons.length">
        <li v-for="(r, i) in trialError.reasons" :key="i">{{ r }}</li>
      </ul>
    </div>

    <template v-else-if="trial">
      <!-- 1. HEADER -->
      <section data-test="header">
        <h1>Trial <span class="mono" data-test="trial-id">{{ trial.id }}</span></h1>
        <p>
          <RouterLink :to="`/experiments/${trial.experiment_id}`" data-test="back-link">Back to experiment {{ experiment ? experiment.name : shortId(trial.experiment_id) }}</RouterLink>
        </p>
        <div v-if="experimentError" class="error" role="alert" data-test="experiment-error">
          <strong>Could not load the experiment (the config name above is a short id): {{ experimentError.message }}</strong>
          <ul v-if="experimentError.reasons.length">
            <li v-for="(r, i) in experimentError.reasons" :key="i">{{ r }}</li>
          </ul>
        </div>

        <div class="top-line">
          <span class="big-verdict" :class="trial.passed === true ? 'pass' : trial.passed === false ? 'fail' : 'muted'" data-test="verdict">
            {{ trial.passed === true ? 'PASS' : trial.passed === false ? 'FAIL' : 'no verdict' }}
          </span>
          <span>exit reason <strong data-test="exit-reason">{{ trial.exit_reason ?? 'none' }}</strong></span>
          <span>steps <strong data-test="steps">{{ int(trial.steps) }}</strong></span>
          <StatusChip :status="trial.status" />
        </div>

        <div v-if="trial.error_class || trial.error_message" class="error" data-test="trial-error-info">
          <strong>error class {{ trial.error_class ?? 'none' }}</strong><template v-if="trial.error_message">: {{ trial.error_message }}</template>
        </div>

        <dl class="kv">
          <dt>Config</dt><dd data-test="config-name">{{ configName }}</dd>
          <dt>Task</dt><dd class="mono">{{ trial.task_id }}</dd>
          <dt>Trial index</dt><dd>{{ trial.trial_index }}</dd>
          <dt>Attempts</dt><dd>{{ trial.attempt_count }}</dd>
          <dt>Cost</dt><dd>{{ usd(trial.cost_usd) }}</dd>
          <dt>Latency</dt><dd>{{ seconds(trial.latency_ms) }}</dd>
          <dt>Input tokens</dt><dd>{{ int(trial.input_tokens) }}</dd>
          <dt>Output tokens</dt><dd>{{ int(trial.output_tokens) }}</dd>
          <dt>Cache-read tokens</dt><dd>{{ int(trial.cache_read_tokens) }}</dd>
          <dt>Reasoning tokens</dt><dd>{{ int(trial.reasoning_tokens) }}</dd>
          <dt>API calls</dt><dd>{{ int(trial.api_calls) }}</dd>
          <dt>Rate-limit events</dt><dd>{{ trial.rate_limit_events }}</dd>
          <dt>Started</dt><dd>{{ when(trial.started_at) }}</dd>
          <dt>Ended</dt><dd>{{ when(trial.ended_at) }}</dd>
        </dl>
      </section>

      <div v-if="traceError" class="error" role="alert" data-test="trace-error">
        <strong>Could not load the trace: {{ traceError.message }}</strong>
        <ul v-if="traceError.reasons.length">
          <li v-for="(r, i) in traceError.reasons" :key="i">{{ r }}</li>
        </ul>
      </div>

      <div v-if="partialTrace" class="warn" data-test="partial-banner">
        <strong>{{ trial.status === 'cancelled' ? 'partial trace: this trial was cancelled; only the events of its last attempt were kept' : 'partial trace: this trial errored; only the events of its last attempt were kept' }}</strong>
        <div>error class: <span class="mono">{{ partialTrace.error_class ?? trial.error_class ?? 'none' }}</span></div>
        <div>error message: {{ partialTrace.error_message ?? trial.error_message ?? 'none' }}</div>
      </div>

      <!-- 2. WHY IT FAILED -->
      <section v-if="trial.passed === false" data-test="why">
        <h2>Why it failed</h2>
        <div v-if="trial.failure_category" class="failure-category" data-test="failure-category">
          <div>
            Failure category <strong class="mono" data-test="failure-category-name">{{ trial.failure_category }}</strong>
            <span class="muted small" data-test="failure-rule">rule {{ evidence?.rule ?? '?' }}: {{ FAILURE_RULE[trial.failure_category] }}</span>
          </div>
          <div v-if="evidence" data-test="failure-detail">{{ evidence.detail }}</div>
          <div v-if="evidence && (evidence.event_seq !== undefined || evidence.related_event_seq !== undefined || evidence.grader_index !== undefined)" class="row" data-test="failure-evidence">
            <span class="muted small">evidence</span>
            <template v-if="evidence.event_seq !== undefined">
              <button v-if="eventExists(evidence.event_seq)" type="button" data-test="evidence-event" @click="goToEvent(evidence.event_seq)">event #{{ evidence.event_seq }}</button>
              <span v-else class="muted" data-test="evidence-event-missing">event #{{ evidence.event_seq }} (not in the loaded trace)</span>
            </template>
            <template v-if="evidence.related_event_seq !== undefined">
              <button v-if="eventExists(evidence.related_event_seq)" type="button" data-test="evidence-related-event" @click="goToEvent(evidence.related_event_seq)">event #{{ evidence.related_event_seq }}</button>
              <span v-else class="muted">event #{{ evidence.related_event_seq }} (not in the loaded trace)</span>
            </template>
            <button v-if="evidence.grader_index !== undefined" type="button" data-test="evidence-grader" @click="goToGrader(evidence.grader_index)">grader #{{ evidence.grader_index }}</button>
          </div>
        </div>
        <p v-else class="muted small" data-test="failure-category-none">No failure category is stored for this trial yet (run npm run failures:backfill in the api container).</p>
        <p v-if="whyNoGrader" data-test="why-no-grader">{{ whyNoGrader }}</p>
        <p v-else-if="!whyItems.length" class="muted">No grader result is marked failed in the recorded results.</p>
        <ul class="why-list">
          <li v-for="w in whyItems" :key="w.key" class="why-item">
            <strong class="mono">{{ w.type }}</strong> <span class="muted small">grader #{{ w.key }}</span>
            <div v-for="(line, i) in w.lines" :key="i" class="why-line">{{ line }}</div>
            <template v-if="w.reasoning !== null">
              <div class="small muted">Judge reasoning (verbatim)</div>
              <pre class="why-reasoning">{{ w.reasoning }}</pre>
            </template>
          </li>
        </ul>
      </section>

      <!-- 3. GRADER RESULTS -->
      <section data-test="graders">
        <h2>Grader results</h2>
        <p v-if="!graderResults.length" class="muted">No grader results were recorded for this trial.</p>
        <GraderDetail v-for="g in graderResults" :key="g.grader_index" :result="g" />
      </section>

      <!-- 4. TASK PROMPT and FINAL RESPONSE -->
      <section data-test="prompt">
        <h2>Task prompt</h2>
        <template v-if="promptText !== null">
          <div class="small muted">taken from {{ promptSource }}</div>
          <pre class="block" data-test="prompt-text">{{ promptText }}</pre>
          <p v-if="promptTruncation && userPrompt !== null" class="warn small" data-test="prompt-truncated">{{ promptTruncation }}</p>
        </template>
        <template v-else>
          <p v-if="!tasksChecked" class="muted">Looking up the task prompt...</p>
          <p v-else class="muted" data-test="prompt-unavailable">
            task prompt unavailable: the trace has no user message, and the task registry has no task {{ trial.task_id }} with version hash {{ shortId(trial.task_version_hash) }}
          </p>
          <div v-if="tasksError" class="error" role="alert">
            <strong>Could not load the task registry: {{ tasksError.message }}</strong>
            <ul v-if="tasksError.reasons.length">
              <li v-for="(r, i) in tasksError.reasons" :key="i">{{ r }}</li>
            </ul>
          </div>
        </template>
      </section>

      <section v-if="fullTrace" data-test="final-response">
        <h2>Final response</h2>
        <pre v-if="fullTrace.final_response !== null" class="block">{{ fullTrace.final_response }}</pre>
        <p v-else class="muted">The trial recorded no final response.</p>
      </section>

      <!-- 5. EVENT TIMELINE -->
      <section data-test="timeline">
        <h2>Event timeline</h2>
        <p v-if="!events.length" class="muted">The trace has no events.</p>
        <template v-else>
          <div class="row timeline-controls">
            <button type="button" data-test="expand-all" @click="expandAll">Expand all</button>
            <button type="button" data-test="collapse-all" @click="collapseAll">Collapse all</button>
            <label v-for="k in kindCounts" :key="k.kind" class="kind-filter small">
              <input type="checkbox" :checked="!disabledKinds.has(k.kind)" :data-kind-filter="k.kind" @change="setKind(k.kind, ($event.target as HTMLInputElement).checked)" />
              {{ k.label }} ({{ k.count }})
            </label>
          </div>
          <div v-if="windowed" class="row pager" data-test="pager">
            <button type="button" data-test="prev" :disabled="windowStart === 0" @click="prev">Previous</button>
            <span data-test="window-text">{{ windowText }}</span>
            <button type="button" data-test="next" :disabled="windowStart + 200 >= filtered.length" @click="next">Next</button>
          </div>
          <p v-else class="small muted" data-test="shown-count">{{ filtered.length }} of {{ events.length }} events shown</p>
          <ol class="events">
            <TraceEvent v-for="e in visible" :key="e.seq" :event="e" :expanded="expanded.has(e.seq)" :paired="pairedWith(e)" :focused="focusedSeq === e.seq" @toggle="toggle" />
          </ol>
        </template>
      </section>

      <!-- 6. MEMORY -->
      <section v-if="fullTrace" data-test="memory">
        <h2>Memory</h2>
        <p v-if="memoryChanged" class="notice" data-test="memory-changed">memory changed during the trial</p>
        <p v-if="!memoryFiles.length" class="muted">No memory files were present at the start or at the end of the trial.</p>
        <details v-for="f in memoryFiles" :key="f.name" class="mem-file" :open="f.differs" :data-memory-file="f.name">
          <summary><span class="mono">{{ f.name }}</span> {{ f.differs ? '(changed)' : '(unchanged)' }}</summary>
          <div class="side-by-side">
            <div>
              <div class="small muted">memory_initial</div>
              <pre v-if="f.before !== undefined" class="block">{{ f.before }}</pre>
              <div v-else class="small muted">(absent)</div>
            </div>
            <div>
              <div class="small muted">memory_final</div>
              <pre v-if="f.after !== undefined" class="block">{{ f.after }}</pre>
              <div v-else class="small muted">(absent)</div>
            </div>
          </div>
        </details>
        <h3>Skills invoked</h3>
        <ul v-if="fullTrace.skills_invoked.length" data-test="skills">
          <li v-for="(s, i) in fullTrace.skills_invoked" :key="i" class="mono">{{ s }}</li>
        </ul>
        <p v-else class="muted small">none</p>
        <h3>Adapter notes</h3>
        <ul v-if="fullTrace.notes.length" data-test="notes">
          <li v-for="(n, i) in fullTrace.notes" :key="i">{{ n }}</li>
        </ul>
        <p v-else class="muted small">none</p>
      </section>

      <!-- 7. SYSTEM PROMPT -->
      <section v-if="fullTrace" data-test="system-prompt-section">
        <h2>System prompt</h2>
        <details v-if="systemPrompt !== null" data-test="system-prompt">
          <summary>System prompt ({{ systemPrompt.length }} characters)</summary>
          <pre class="block">{{ systemPrompt }}</pre>
        </details>
        <p v-else class="muted">The harness did not capture a system prompt for this trial.</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.top-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 18px; margin: 8px 0; font-size: 15px; }
.big-verdict { font-size: 30px; font-weight: 700; letter-spacing: 1px; }
.kv { display: grid; grid-template-columns: max-content 1fr max-content 1fr; gap: 3px 16px; margin: 8px 0; max-width: 900px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; font-variant-numeric: tabular-nums; }
.block { background: var(--bg-soft); border: 1px solid var(--line); border-radius: 4px; padding: 8px 10px; max-height: 480px; overflow: auto; }
.failure-category { border: 1px solid var(--line); background: var(--bg-soft); border-radius: 4px; padding: 6px 10px; margin: 6px 0; }
.failure-category .row { gap: 8px; margin-top: 4px; }
.why-list { list-style: none; padding: 0; margin: 0; }
.why-item { border: 1px solid var(--bad); background: var(--bad-bg); border-radius: 4px; padding: 6px 10px; margin: 6px 0; }
.why-line { margin: 2px 0; }
.why-reasoning { background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 6px 8px; margin-top: 3px; }
.timeline-controls { margin-bottom: 6px; gap: 12px; }
.kind-filter { display: inline-flex; align-items: center; gap: 4px; }
.pager { margin: 6px 0; gap: 12px; }
.events { margin: 6px 0 0; padding: 0; border-top: 1px solid var(--line); }
.mem-file { margin: 6px 0; }
.side-by-side { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
</style>
