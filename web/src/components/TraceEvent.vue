<script setup lang="ts">
// One row of the trial event timeline. A collapsed row is 1 line (a button, so Enter and Space toggle it);
// an expanded row shows the full content. Everything from the trace is untrusted text: it is only ever
// rendered with interpolation, never as HTML.
import { computed } from 'vue';
import type { TraceEvent as Ev } from '../api/types';
import { ms, seconds } from '../lib/format';

const props = defineProps<{
  event: Ev;
  expanded: boolean;
  /** For a tool_call: its tool_result. For a tool_result: the tool_call it answers. Matched on call_id by the parent. */
  paired?: Ev | null;
}>();

const emit = defineEmits<{ (e: 'toggle', seq: number): void }>();

const LABELS: Record<Ev['kind'], string> = {
  message: 'MESSAGE',
  tool_call: 'TOOL CALL',
  tool_result: 'TOOL RESULT',
  api_call: 'API CALL',
  memory_read: 'MEMORY READ',
  memory_write: 'MEMORY WRITE',
  skill_invoked: 'SKILL',
  error: 'ERROR',
};

const label = computed(() => LABELS[props.event.kind]);

const rowClass = computed(() => {
  switch (props.event.kind) {
    case 'memory_read':
    case 'memory_write':
      return 'ev-memory';
    case 'skill_invoked':
      return 'ev-skill';
    case 'error':
      return 'ev-error';
    case 'api_call':
      return 'ev-api';
    default:
      return 'ev-plain';
  }
});

const oneLine = (s: string, n = 100): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}...` : flat;
};

const pretty = (v: unknown): string => JSON.stringify(v, null, 2) ?? 'undefined';
const argsPreview = (args: Record<string, unknown>): string => oneLine(JSON.stringify(args) ?? '', 80);

const summary = computed(() => {
  const e = props.event;
  switch (e.kind) {
    case 'message':
      return `${e.role}: ${oneLine(e.content)}`;
    case 'tool_call':
      return `${e.tool} (${e.harness_tool}) ${argsPreview(e.args)}`;
    case 'tool_result':
      return `${e.is_error ? 'ERROR' : 'ok'}, ${e.duration_ms} ms, ${oneLine(e.output)}`;
    case 'api_call':
      return `step ${e.step}, ${e.model}, in ${e.input_tokens} / out ${e.output_tokens} tokens, ${ms(e.latency_ms)}`;
    case 'memory_read':
      return `${e.file}, loaded by ${e.loaded_by}`;
    case 'memory_write':
      return `${e.file}, ${e.op}`;
    case 'skill_invoked':
      return `${e.name}, via ${e.via}`;
    case 'error':
      return `${e.stage}: ${oneLine(e.message)} (${e.retryable ? 'retryable' : 'not retryable'})`;
  }
  return '';
});

/** api_call status: ok is plain, retry is warn, error is bad. Words always printed. */
const apiStatusClass = computed(() => {
  if (props.event.kind !== 'api_call') return '';
  return props.event.status === 'ok' ? '' : props.event.status === 'retry' ? 'badge badge-warn' : 'badge badge-bad';
});

const truncation = computed(() => {
  const e = props.event;
  if ('truncated' in e && e.truncated) {
    return `truncated, original length ${'orig_len' in e && e.orig_len !== undefined ? e.orig_len : 'unknown'} characters`;
  }
  return null;
});

const pairedResult = computed(() => (props.paired && props.paired.kind === 'tool_result' ? props.paired : null));
const pairedCall = computed(() => (props.paired && props.paired.kind === 'tool_call' ? props.paired : null));
</script>

<template>
  <li class="ev" :class="rowClass" :data-seq="event.seq" :data-kind="event.kind">
    <button type="button" class="ev-head" :aria-expanded="expanded" @click="emit('toggle', event.seq)">
      <span class="ev-caret" aria-hidden="true">{{ expanded ? 'v' : '>' }}</span>
      <span class="ev-seq mono">#{{ event.seq }}</span>
      <span class="ev-t mono">{{ seconds(event.t_ms) }}</span>
      <span class="badge ev-kind">{{ label }}</span>
      <span v-if="event.kind === 'api_call'" class="ev-status" :class="apiStatusClass">{{ event.status }}{{ event.http_status != null ? ` ${event.http_status}` : '' }}</span>
      <span v-if="event.kind === 'tool_result'" class="ev-status" :class="event.is_error ? 'badge badge-bad' : ''">{{ event.is_error ? 'error' : 'ok' }}</span>
      <span class="ev-summary">{{ summary }}</span>
      <span v-if="truncation" class="badge badge-warn">truncated</span>
    </button>

    <div v-if="expanded" class="ev-body">
      <p v-if="truncation" class="warn small">{{ truncation }}</p>

      <template v-if="event.kind === 'message'">
        <div class="small muted">role {{ event.role }}, step {{ event.step }}</div>
        <pre class="ev-content">{{ event.content }}</pre>
      </template>

      <template v-else-if="event.kind === 'tool_call'">
        <div class="small muted">tool {{ event.tool }}, harness tool {{ event.harness_tool }}, step {{ event.step }}, call id <span class="mono">{{ event.call_id }}</span></div>
        <div class="small muted">args</div>
        <pre class="ev-args">{{ pretty(event.args) }}</pre>
        <div class="ev-pair">
          <template v-if="pairedResult">
            <div class="small" :class="pairedResult.is_error ? 'fail' : 'muted'">
              result ({{ pairedResult.is_error ? 'ERROR' : 'ok' }}, {{ pairedResult.duration_ms }} ms, event #{{ pairedResult.seq }})
            </div>
            <p v-if="'truncated' in pairedResult && pairedResult.truncated" class="warn small">
              truncated, original length {{ pairedResult.orig_len ?? 'unknown' }} characters
            </p>
            <pre class="ev-paired-output" :class="{ 'ev-out-error': pairedResult.is_error }">{{ pairedResult.output }}</pre>
          </template>
          <div v-else class="small muted">no tool_result with this call id in the trace</div>
        </div>
      </template>

      <template v-else-if="event.kind === 'tool_result'">
        <div class="small muted">call id <span class="mono">{{ event.call_id }}</span>, {{ event.duration_ms }} ms, {{ event.is_error ? 'ERROR' : 'ok' }}</div>
        <div v-if="pairedCall" class="small ev-pair">
          answers tool call #{{ pairedCall.seq }}: {{ pairedCall.tool }} ({{ pairedCall.harness_tool }}) {{ argsPreview(pairedCall.args) }}
        </div>
        <div v-else class="small muted">no tool_call with this call id in the trace</div>
        <pre class="ev-output" :class="{ 'ev-out-error': event.is_error }">{{ event.output }}</pre>
      </template>

      <template v-else-if="event.kind === 'api_call'">
        <table class="ev-fields">
          <tbody>
            <tr><th>step</th><td>{{ event.step }}</td></tr>
            <tr><th>model</th><td class="mono">{{ event.model }}</td></tr>
            <tr><th>input tokens</th><td>{{ event.input_tokens }}</td></tr>
            <tr><th>output tokens</th><td>{{ event.output_tokens }}</td></tr>
            <tr><th>latency</th><td>{{ ms(event.latency_ms) }}</td></tr>
            <tr><th>status</th><td><span :class="apiStatusClass">{{ event.status }}</span></td></tr>
            <tr><th>http status</th><td>{{ event.http_status == null ? 'none' : event.http_status }}</td></tr>
          </tbody>
        </table>
      </template>

      <template v-else-if="event.kind === 'memory_read'">
        <div class="small muted">file {{ event.file }}, loaded by {{ event.loaded_by }}</div>
        <pre class="ev-content">{{ event.content }}</pre>
      </template>

      <template v-else-if="event.kind === 'memory_write'">
        <div class="small muted">file {{ event.file }}, op {{ event.op }}</div>
        <div class="small muted">args</div>
        <pre class="ev-args">{{ pretty(event.args) }}</pre>
        <div class="small muted">content after</div>
        <pre v-if="event.content_after !== null" class="ev-content">{{ event.content_after }}</pre>
        <div v-else class="small muted">(not recorded)</div>
      </template>

      <template v-else-if="event.kind === 'skill_invoked'">
        <div>skill <strong>{{ event.name }}</strong>, invoked via {{ event.via }}</div>
      </template>

      <template v-else-if="event.kind === 'error'">
        <div class="small muted">
          stage {{ event.stage }}, {{ event.retryable ? 'retryable' : 'not retryable' }}<template v-if="event.http_status !== undefined && event.http_status !== null">, http status {{ event.http_status }}</template>
        </div>
        <pre class="ev-content">{{ event.message }}</pre>
      </template>
    </div>
  </li>
</template>

<style scoped>
.ev { list-style: none; border-bottom: 1px solid var(--line); border-left: 4px solid transparent; }
.ev-head { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left; background: transparent; border: 0; border-radius: 0; padding: 3px 6px; cursor: pointer; }
.ev-head:hover:not(:disabled) { background: rgba(0, 0, 0, 0.04); }
.ev-caret { width: 10px; color: var(--muted); font-family: ui-monospace, Menlo, Consolas, monospace; }
.ev-seq { min-width: 44px; color: var(--muted); }
.ev-t { min-width: 56px; color: var(--muted); }
.ev-kind { min-width: 104px; text-align: center; }
.ev-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ev-body { padding: 4px 10px 10px 30px; }
.ev-body pre { background: var(--bg-soft); border: 1px solid var(--line); border-radius: 4px; padding: 6px 8px; margin: 3px 0 6px; max-height: 420px; overflow: auto; }
.ev-pair { margin-top: 6px; }
.ev-out-error { color: var(--bad); background: var(--bad-bg) !important; }
.ev-fields { width: auto; }

.ev-api { color: var(--muted); }
.ev-api .ev-kind { background: transparent; }
.ev-memory { border-left-color: #7a4fc4; background: #f1ebfb; }
.ev-memory .ev-kind { background: #e1d5f5; color: #4b2a8c; }
.ev-skill { border-left-color: #0a7d8c; background: #e3f3f5; }
.ev-skill .ev-kind { background: #c9e8ec; color: #05525c; }
.ev-error { border-left-color: var(--bad); background: var(--bad-bg); }
.ev-error .ev-kind { background: var(--bad-bg); color: var(--bad); }
</style>
