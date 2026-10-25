<script setup lang="ts">
// The trial inspector (cards/P4.md section 5): a reader must be able to say why a trial failed from this page alone.
// Nothing here decides pass or fail or computes a statistic: every verdict comes from the API's grader results, and
// the "why it failed" lines only restate those results in words. Trace text is untrusted and is never rendered as HTML.
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ApiError, api } from '../api/client';
import type { ExperimentDetail, FailureEvidence, FullTrace, GraderResult, PartialTrace, Task, Trace, TraceEvent as TraceEv, Trial } from '../api/types';
import GraderDetail from '../components/GraderDetail.vue';
import Skeleton from '../components/Skeleton.vue';
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
  <div ref="root" class="trial-view page">
    <div v-if="loading" class="panel">
      <Skeleton variant="lines" :rows="5" />
      <p class="muted small">Loading trial...</p>
    </div>

    <div v-else-if="trialError" class="error" role="alert" data-test="trial-error">
      <strong>Could not load trial {{ id }}: {{ trialError.message }}</strong>
      <ul v-if="trialError.reasons.length">
        <li v-for="(r, i) in trialError.reasons" :key="i">{{ r }}</li>
      </ul>
    </div>

    <template v-else-if="trial">
      <!-- 1. HEADER -->
      <section class="trial-head" data-test="header">
        <p class="crumb">
          <RouterLink :to="`/experiments/${trial.experiment_id}`" data-test="back-link">Back to experiment {{ experiment ? experiment.name : shortId(trial.experiment_id) }}</RouterLink>
        </p>
        <div v-if="experimentError" class="error" role="alert" data-test="experiment-error">
          <strong>Could not load the experiment (the config name above is a short id): {{ experimentError.message }}</strong>
          <ul v-if="experimentError.reasons.length">
            <li v-for="(r, i) in experimentError.reasons" :key="i">{{ r }}</li>
          </ul>
        </div>

        <div class="top-line">
          <span class="big-verdict verdict-pill" :class="trial.passed === true ? 'pass' : trial.passed === false ? 'fail' : 'muted'" data-test="verdict">
            {{ trial.passed === true ? 'PASS' : trial.passed === false ? 'FAIL' : 'no verdict' }}
          </span>
          <div class="title-block">
            <h1>Trial <span class="mono trial-id" data-test="trial-id">{{ trial.id }}</span></h1>
            <div class="facts">
              <span>exit reason <strong class="mono" data-test="exit-reason">{{ trial.exit_reason ?? 'none' }}</strong></span>
              <span>steps <strong class="mono" data-test="steps">{{ int(trial.steps) }}</strong></span>
              <StatusChip :status="trial.status" />
            </div>
          </div>
        </div>

        <div v-if="trial.error_class || trial.error_message" class="error" data-test="trial-error-info">
          <strong>error class {{ trial.error_class ?? 'none' }}</strong><template v-if="trial.error_message">: {{ trial.error_message }}</template>
        </div>

        <dl class="kv card trial-kv">
          <dt>Config</dt><dd data-test="config-name">{{ configName }}</dd>
          <dt>Task</dt><dd class="mono">{{ trial.task_id }}</dd>
          <dt>Trial index</dt><dd class="mono">{{ trial.trial_index }}</dd>
          <dt>Attempts</dt><dd class="mono">{{ trial.attempt_count }}</dd>
          <dt>Cost</dt><dd class="mono">{{ usd(trial.cost_usd) }}</dd>
          <dt>Latency</dt><dd class="mono">{{ seconds(trial.latency_ms) }}</dd>
          <dt>Input tokens</dt><dd class="mono">{{ int(trial.input_tokens) }}</dd>
          <dt>Output tokens</dt><dd class="mono">{{ int(trial.output_tokens) }}</dd>
          <dt>Cache-read tokens</dt><dd class="mono">{{ int(trial.cache_read_tokens) }}</dd>
          <dt>Reasoning tokens</dt><dd class="mono">{{ int(trial.reasoning_tokens) }}</dd>
          <dt>API calls</dt><dd class="mono">{{ int(trial.api_calls) }}</dd>
          <dt>Rate-limit events</dt><dd class="mono">{{ trial.rate_limit_events }}</dd>
          <dt>Started</dt><dd class="mono">{{ when(trial.started_at) }}</dd>
          <dt>Ended</dt><dd class="mono">{{ when(trial.ended_at) }}</dd>
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
      <section v-if="trial.passed === false" class="panel why" data-test="why">
        <h2>Why it failed</h2>
        <div v-if="trial.failure_category" class="failure-category" data-test="failure-category">
          <div class="fc-line">
            <span class="muted small">Failure category</span>
            <strong class="mono fc-name" data-test="failure-category-name">{{ trial.failure_category }}</strong>
            <span class="muted small" data-test="failure-rule">rule {{ evidence?.rule ?? '?' }}: {{ FAILURE_RULE[trial.failure_category] }}</span>
          </div>
          <div v-if="evidence" class="fc-detail" data-test="failure-detail">{{ evidence.detail }}</div>
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
      <section class="graders" data-test="graders">
        <div class="section-title"><h2>Grader results</h2></div>
        <p v-if="!graderResults.length" class="muted">No grader results were recorded for this trial.</p>
        <GraderDetail v-for="g in graderResults" :key="g.grader_index" :result="g" />
      </section>

      <!-- 4. TASK PROMPT and FINAL RESPONSE -->
      <div class="io">
        <section class="panel" data-test="prompt">
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

        <section v-if="fullTrace" class="panel" data-test="final-response">
          <h2>Final response</h2>
          <pre v-if="fullTrace.final_response !== null" class="block">{{ fullTrace.final_response }}</pre>
          <p v-else class="muted">The trial recorded no final response.</p>
        </section>
      </div>

      <!-- 5. EVENT TIMELINE -->
      <section class="panel panel-flush timeline" data-test="timeline">
        <div class="section-title">
          <h2>Event timeline</h2>
          <p v-if="events.length && !windowed" class="small muted" data-test="shown-count">{{ filtered.length }} of {{ events.length }} events shown</p>
        </div>
        <p v-if="!events.length" class="muted timeline-empty">The trace has no events.</p>
        <template v-else>
          <div class="row timeline-controls">
            <button type="button" data-test="expand-all" @click="expandAll">Expand all</button>
            <button type="button" data-test="collapse-all" @click="collapseAll">Collapse all</button>
            <span class="divider" aria-hidden="true" />
            <label v-for="k in kindCounts" :key="k.kind" class="kind-filter small" :class="{ off: disabledKinds.has(k.kind) }">
              <input type="checkbox" :checked="!disabledKinds.has(k.kind)" :data-kind-filter="k.kind" @change="setKind(k.kind, ($event.target as HTMLInputElement).checked)" />
              {{ k.label }} ({{ k.count }})
            </label>
          </div>
          <div v-if="windowed" class="row pager" data-test="pager">
            <button type="button" data-test="prev" :disabled="windowStart === 0" @click="prev">Previous</button>
            <span class="mono small" data-test="window-text">{{ windowText }}</span>
            <button type="button" data-test="next" :disabled="windowStart + 200 >= filtered.length" @click="next">Next</button>
          </div>
          <ol class="events">
            <TraceEvent v-for="e in visible" :key="e.seq" :event="e" :expanded="expanded.has(e.seq)" :paired="pairedWith(e)" :focused="focusedSeq === e.seq" @toggle="toggle" />
          </ol>
        </template>
      </section>

      <!-- 6. MEMORY -->
      <section v-if="fullTrace" class="panel memory" data-test="memory">
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
        <div class="mem-lists">
          <div>
            <h3>Skills invoked</h3>
            <ul v-if="fullTrace.skills_invoked.length" data-test="skills">
              <li v-for="(s, i) in fullTrace.skills_invoked" :key="i" class="mono">{{ s }}</li>
            </ul>
            <p v-else class="muted small">none</p>
          </div>
          <div>
            <h3>Adapter notes</h3>
            <ul v-if="fullTrace.notes.length" data-test="notes">
              <li v-for="(n, i) in fullTrace.notes" :key="i">{{ n }}</li>
            </ul>
            <p v-else class="muted small">none</p>
          </div>
        </div>
      </section>

      <!-- 7. SYSTEM PROMPT -->
      <section v-if="fullTrace" class="panel" data-test="system-prompt-section">
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
.trial-head { display: flex; flex-direction: column; gap: var(--space-4); }
.top-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4) var(--space-5); }
.big-verdict { min-width: 112px; justify-content: center; }
.title-block { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.trial-id { font-size: var(--fs-16); font-weight: var(--fw-regular); color: var(--text-muted); }
.facts { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-5); font-size: var(--fs-13); color: var(--text-muted); }
.facts strong { color: var(--text); }
.trial-kv { grid-template-columns: max-content minmax(0, 1fr) max-content minmax(0, 1fr) max-content minmax(0, 1fr); gap: var(--space-2) var(--space-5); }
.trial-kv dd { font-size: var(--fs-12); align-self: center; }

.why { display: flex; flex-direction: column; gap: var(--space-3); border-color: rgb(255 92 108 / 0.35); }
.failure-category { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-control); }
.fc-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2) var(--space-3); }
.fc-name { font-size: var(--fs-14); color: var(--fail-text); }
.fc-detail { font-size: var(--fs-13); }
.failure-category .row { gap: var(--space-2); }
.failure-category button { height: 26px; font-family: var(--font-mono); font-size: var(--fs-12); font-weight: var(--fw-regular); color: var(--accent-text); }
.why-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.why-item { border: 1px solid rgb(255 92 108 / 0.35); background: var(--fail-tint); border-radius: var(--radius-control); padding: var(--space-3) var(--space-4); font-size: var(--fs-13); }
.why-line { margin: var(--space-1) 0 0; }
.why-reasoning { background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-control); padding: var(--space-2) var(--space-3); margin-top: var(--space-1); font-size: var(--fs-12); }

.graders { display: flex; flex-direction: column; gap: var(--space-3); }
.graders .section-title { margin-bottom: 0; }
.io { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-4); align-items: start; }
.io .panel { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }

.timeline .section-title { margin: 0; padding: var(--space-4) var(--space-5) var(--space-3); }
.timeline-empty { padding: 0 var(--space-5) var(--space-5); }
.timeline-controls { gap: var(--space-2) var(--space-3); padding: 0 var(--space-5) var(--space-3); }
.divider { width: 1px; height: 20px; background: var(--border); }
.kind-filter { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius-pill); font-family: var(--font-mono); cursor: pointer; transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out); }
.kind-filter:hover { border-color: var(--border-strong); }
.kind-filter.off { color: var(--text-muted); }
.kind-filter input { width: 13px; height: 13px; }
.pager { gap: var(--space-3); padding: 0 var(--space-5) var(--space-3); }
.events { margin: 0; padding: 0; border-top: 1px solid var(--border); }

.memory { display: flex; flex-direction: column; gap: var(--space-3); }
.mem-file .side-by-side { margin-top: var(--space-2); }
.mem-lists { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-5); }
.mem-lists ul { margin: var(--space-1) 0 0; padding-left: 18px; font-size: var(--fs-13); }
.side-by-side { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.block { margin-top: var(--space-1); }

@media (max-width: 1180px) {
  .io { grid-template-columns: minmax(0, 1fr); }
  .trial-kv { grid-template-columns: max-content minmax(0, 1fr) max-content minmax(0, 1fr); }
}
</style>
