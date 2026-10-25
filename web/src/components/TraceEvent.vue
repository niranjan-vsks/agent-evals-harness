<script setup lang="ts">
// One row of the trial event timeline. A collapsed row is 1 line (a button, so Enter and Space toggle it);
// an expanded row shows the full content. P7: the kind has an icon next to its label, a gutter line joins a tool_call to
// its tool_result, and memory, skill and error rows are tinted with the semantic colours. Everything from the trace is
// untrusted text: it is only ever rendered with interpolation, never as HTML.
import { computed } from 'vue';
import type { TraceEvent as Ev } from '../api/types';
import { ms, seconds } from '../lib/format';

const props = defineProps<{
  event: Ev;
  expanded: boolean;
  /** For a tool_call: its tool_result. For a tool_result: the tool_call it answers. Matched on call_id by the parent. */
  paired?: Ev | null;
  /** The event a failure-category link pointed at: drawn with an outline until another link is followed. */
  focused?: boolean;
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
  <li
    :id="`event-${event.seq}`"
    class="ev"
    :class="[rowClass, { 'ev-focus': focused, 'ev-open': expanded, 'ev-link-down': event.kind === 'tool_call' && pairedResult, 'ev-link-up': event.kind === 'tool_result' && pairedCall }]"
    :data-seq="event.seq"
    :data-kind="event.kind"
    :data-focused="focused ? 'true' : undefined"
  >
    <span class="ev-gutter" aria-hidden="true"><span class="ev-node" /></span>
    <button type="button" class="ev-head" :aria-expanded="expanded" @click="emit('toggle', event.seq)">
      <span class="ev-caret" aria-hidden="true" />
      <span class="ev-seq mono">#{{ event.seq }}</span>
      <span class="ev-t mono">{{ seconds(event.t_ms) }}</span>
      <span class="ev-kind-wrap">
        <svg class="ev-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <path v-if="event.kind === 'message'" d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
          <path v-else-if="event.kind === 'tool_call'" d="M2.5 8h9M8.5 4.5 12 8l-3.5 3.5" />
          <path v-else-if="event.kind === 'tool_result'" d="M13.5 8h-9M7.5 4.5 4 8l3.5 3.5" />
          <path v-else-if="event.kind === 'api_call'" d="M8 2.5v11M2.5 8h11M4.5 4.5l7 7M11.5 4.5l-7 7" />
          <path v-else-if="event.kind === 'memory_read' || event.kind === 'memory_write'" d="M3 4h10M3 8h10M3 12h6" />
          <path v-else-if="event.kind === 'skill_invoked'" d="M8 2.5 13.5 8 8 13.5 2.5 8z" />
          <path v-else d="M8 2.5 14 13H2zM8 6.5v3M8 11.2v.1" />
        </svg>
        <span class="ev-kind">{{ label }}</span>
      </span>
      <span v-if="event.kind === 'api_call'" class="ev-status" :class="apiStatusClass">{{ event.status }}{{ event.http_status != null ? ` ${event.http_status}` : '' }}</span>
      <span v-if="event.kind === 'tool_result'" class="ev-status" :class="event.is_error ? 'badge badge-bad' : ''">{{ event.is_error ? 'error' : 'ok' }}</span>
      <span class="ev-summary">{{ summary }}</span>
      <span v-if="pairedResult" class="ev-pairref mono" :title="`answered by event #${pairedResult.seq}`">to #{{ pairedResult.seq }}</span>
      <span v-else-if="pairedCall" class="ev-pairref mono" :title="`answers event #${pairedCall.seq}`">from #{{ pairedCall.seq }}</span>
      <span v-if="truncation" class="badge badge-warn">truncated</span>
    </button>

    <div v-if="expanded" class="ev-body">
      <p v-if="truncation" class="warn small">{{ truncation }}</p>

      <template v-if="event.kind === 'message'">
        <div class="ev-meta">role {{ event.role }}, step {{ event.step }}</div>
        <pre class="ev-content">{{ event.content }}</pre>
      </template>

      <template v-else-if="event.kind === 'tool_call'">
        <div class="ev-meta">tool {{ event.tool }}, harness tool {{ event.harness_tool }}, step {{ event.step }}, call id <span class="mono">{{ event.call_id }}</span></div>
        <div class="ev-meta">args</div>
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
        <div class="ev-meta">call id <span class="mono">{{ event.call_id }}</span>, {{ event.duration_ms }} ms, {{ event.is_error ? 'ERROR' : 'ok' }}</div>
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
            <tr><th>input tokens</th><td class="mono">{{ event.input_tokens }}</td></tr>
            <tr><th>output tokens</th><td class="mono">{{ event.output_tokens }}</td></tr>
            <tr><th>latency</th><td class="mono">{{ ms(event.latency_ms) }}</td></tr>
            <tr><th>status</th><td><span :class="apiStatusClass">{{ event.status }}</span></td></tr>
            <tr><th>http status</th><td class="mono">{{ event.http_status == null ? 'none' : event.http_status }}</td></tr>
          </tbody>
        </table>
      </template>

      <template v-else-if="event.kind === 'memory_read'">
        <div class="ev-meta">file {{ event.file }}, loaded by {{ event.loaded_by }}</div>
        <pre class="ev-content">{{ event.content }}</pre>
      </template>

      <template v-else-if="event.kind === 'memory_write'">
        <div class="ev-meta">file {{ event.file }}, op {{ event.op }}</div>
        <div class="ev-meta">args</div>
        <pre class="ev-args">{{ pretty(event.args) }}</pre>
        <div class="ev-meta">content after</div>
        <pre v-if="event.content_after !== null" class="ev-content">{{ event.content_after }}</pre>
        <div v-else class="small muted">(not recorded)</div>
      </template>

      <template v-else-if="event.kind === 'skill_invoked'">
        <div>skill <strong>{{ event.name }}</strong>, invoked via {{ event.via }}</div>
      </template>

      <template v-else-if="event.kind === 'error'">
        <div class="ev-meta">
          stage {{ event.stage }}, {{ event.retryable ? 'retryable' : 'not retryable' }}<template v-if="event.http_status !== undefined && event.http_status !== null">, http status {{ event.http_status }}</template>
        </div>
        <pre class="ev-content">{{ event.message }}</pre>
      </template>
    </div>
  </li>
</template>

<style scoped>
.ev { position: relative; list-style: none; border-bottom: 1px solid var(--border); padding-left: 28px; transition: background-color var(--dur-fast) var(--ease-out); }
.ev:last-child { border-bottom: 0; }

/* The gutter: a node per event, and a line that joins a tool_call to its tool_result (down from the call, up into the result). */
.ev-gutter { position: absolute; left: 0; top: 0; bottom: 0; width: 28px; pointer-events: none; }
.ev-node { position: absolute; left: 12px; top: 15px; width: 5px; height: 5px; border-radius: 50%; background: var(--border-strong); }
.ev-link-down .ev-gutter::after,
.ev-link-up .ev-gutter::before { content: ''; position: absolute; left: 14px; width: 1px; background: var(--accent); opacity: 0.55; }
.ev-link-down .ev-gutter::after { top: 18px; bottom: -1px; }
.ev-link-up .ev-gutter::before { top: 0; height: 15px; }
.ev-link-down .ev-node, .ev-link-up .ev-node { background: var(--accent); }

.ev-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  height: auto;
  min-height: 34px;
  padding: 6px var(--space-3) 6px 0;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 0;
  font-weight: var(--fw-regular);
  font-size: var(--fs-13);
  color: var(--text);
}
.ev-head:hover:not(:disabled) { background: transparent; border: 0; }
.ev:hover { background: var(--row-hover); }
.ev-head:active:not(:disabled) { transform: none; }
.ev-caret { flex: none; width: 6px; height: 6px; margin: 0 2px; border-right: 1.5px solid var(--text-muted); border-bottom: 1.5px solid var(--text-muted); transform: rotate(-45deg); transition: transform var(--dur-fast) var(--ease-out); }
.ev-open .ev-caret { transform: rotate(45deg); }
.ev-seq { flex: none; min-width: 40px; color: var(--text-muted); }
.ev-t { flex: none; min-width: 52px; color: var(--text-muted); text-align: right; }
.ev-kind-wrap { flex: none; display: inline-flex; align-items: center; gap: 6px; min-width: 128px; color: var(--text-muted); }
.ev-icon { fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.ev-kind { font-family: var(--font-mono); font-size: var(--fs-12); font-weight: var(--fw-strong); }
.ev-status { flex: none; font-family: var(--font-mono); font-size: var(--fs-12); color: var(--text-muted); }
.ev-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--fs-12); }
.ev-pairref { flex: none; font-size: var(--fs-12); color: var(--accent-text); }

.ev-body { padding: var(--space-1) var(--space-4) var(--space-4) calc(6px + 40px + 52px + 3 * var(--space-3)); }
.ev-meta { font-size: var(--fs-12); color: var(--text-muted); margin: var(--space-1) 0; }
.ev-body pre { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-control); padding: var(--space-3); margin: var(--space-1) 0 var(--space-2); max-height: 420px; overflow: auto; font-size: var(--fs-12); }
.ev-pair { margin-top: var(--space-2); padding-left: var(--space-3); border-left: 1px solid var(--accent); }
.ev-out-error { color: var(--fail-text); background: var(--fail-tint) !important; border-color: rgb(255 92 108 / 0.35) !important; }
.ev-fields { width: auto; font-size: var(--fs-12); }
.ev-fields th { background: transparent; padding: 3px var(--space-4) 3px 0; }
.ev-fields td { padding: 3px 0; border-bottom-color: transparent; }
.ev-fields th { border-bottom-color: transparent; }

.ev-focus { box-shadow: inset 0 0 0 2px var(--accent); border-radius: var(--radius-control); }
.ev-api .ev-summary, .ev-api .ev-kind-wrap { color: var(--text-muted); }
.ev-memory { background: var(--info-tint); }
.ev-memory .ev-kind-wrap { color: var(--info-text); }
.ev-skill { background: var(--pass-tint); }
.ev-skill .ev-kind-wrap { color: var(--pass-text); }
.ev-error { background: var(--fail-tint); }
.ev-error .ev-kind-wrap { color: var(--fail-text); }
.ev-plain .ev-kind-wrap { color: var(--text); }
</style>
