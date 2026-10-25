<script setup lang="ts">
// One grader result in full. The details object is type specific (DATA_MODEL 2.10); a shape this component does
// not recognise falls back to pretty-printed JSON, so nothing recorded by a grader is ever hidden.
// Judge reasoning, outputs and inputs are untrusted text: rendered with interpolation only.
import { computed } from 'vue';
import type { GraderResult } from '../api/types';
import { ms } from '../lib/format';

const props = defineProps<{ result: GraderResult }>();

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const objects = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** Strings print as they are, an empty string says so, everything else as compact JSON. */
const show = (v: unknown): string => {
  if (typeof v === 'string') return v === '' ? '(empty string)' : v;
  if (v === undefined) return '(missing)';
  return JSON.stringify(v) ?? String(v);
};
const pretty = (v: unknown): string => JSON.stringify(v, null, 2) ?? 'undefined';

const details = computed<Obj | null>(() => (isObj(props.result.details) ? props.result.details : null));

/** Which renderer applies: the type must match AND the details must have the fields that renderer needs. */
const shape = computed<'exact_match' | 'file_state' | 'unit_test' | 'trace_check' | 'llm_judge' | 'json'>(() => {
  const d = details.value;
  if (!d) return 'json';
  switch (props.result.grader_type) {
    case 'exact_match':
      return 'expected' in d && 'extracted' in d ? 'exact_match' : 'json';
    case 'file_state':
      return Array.isArray(d.checks) ? 'file_state' : 'json';
    case 'unit_test':
      return 'command' in d && ('output' in d || 'exit_code' in d) ? 'unit_test' : 'json';
    case 'trace_check':
      return Array.isArray(d.assertions) ? 'trace_check' : 'json';
    case 'llm_judge':
      return Array.isArray(d.criteria) ? 'llm_judge' : 'json';
    default:
      return 'json';
  }
});

const SHOWN: Record<string, string[]> = {
  exact_match: ['expected', 'extracted', 'normalized', 'used_fallback', 'reason'],
  file_state: ['checks'],
  unit_test: ['command', 'exit_code', 'timed_out', 'output'],
  trace_check: ['assertions'],
  llm_judge: ['criteria', 'pass_rule', 'judged_inputs'],
};

/** Recorded fields the structured view does not print, kept so no recorded value is lost. */
const rest = computed<Obj | null>(() => {
  const d = details.value;
  const shown = SHOWN[shape.value];
  if (!d || !shown) return null;
  const out: Obj = {};
  for (const [k, v] of Object.entries(d)) if (!shown.includes(k)) out[k] = v;
  return Object.keys(out).length ? out : null;
});

const checks = computed(() => objects(details.value?.checks));
const assertions = computed(() => objects(details.value?.assertions));
const criteria = computed(() => objects(details.value?.criteria));
const judgedInputs = computed(() => objects(details.value?.judged_inputs));
const d = (key: string): unknown => details.value?.[key];
</script>

<template>
  <div class="card grader" :data-grader-type="result.grader_type" :data-grader-index="result.grader_index">
    <div class="row grader-head">
      <strong class="mono">{{ result.grader_type }}</strong>
      <span class="muted small">grader #{{ result.grader_index }}</span>
      <span class="grader-verdict" :class="result.passed ? 'pass' : 'fail'">{{ result.passed ? 'PASS' : 'FAIL' }}</span>
      <span class="muted small">{{ ms(result.duration_ms) }}</span>
    </div>

    <template v-if="shape === 'exact_match'">
      <div class="side-by-side">
        <div>
          <div class="small muted">Expected</div>
          <pre class="mono g-expected">{{ show(d('expected')) }}</pre>
        </div>
        <div>
          <div class="small muted">Extracted</div>
          <pre class="mono g-extracted">{{ show(d('extracted')) }}</pre>
        </div>
      </div>
      <div v-if="d('reason') !== undefined" class="small g-reason">reason: <strong>{{ show(d('reason')) }}</strong></div>
      <div v-if="'normalized' in (details ?? {}) || 'used_fallback' in (details ?? {})" class="small">
        normalized: <span class="mono">{{ show(d('normalized')) }}</span>;
        used fallback: <strong>{{ d('used_fallback') === true ? 'true' : d('used_fallback') === false ? 'false' : show(d('used_fallback')) }}</strong>
        <span v-if="d('used_fallback') === true" class="muted"> (no FINAL line was found in the response)</span>
      </div>
    </template>

    <template v-else-if="shape === 'file_state'">
      <table class="g-checks">
        <thead><tr><th>check</th><th>result</th><th>reason</th></tr></thead>
        <tbody>
          <tr v-for="(c, i) in checks" :key="i">
            <td class="mono">{{ show(c.check) }}</td>
            <td :class="c.passed === true ? 'pass' : 'fail'">{{ c.passed === true ? 'passed' : 'failed' }}</td>
            <td>{{ show(c.reason) }}</td>
          </tr>
        </tbody>
      </table>
    </template>

    <template v-else-if="shape === 'unit_test'">
      <div class="small">command: <span class="mono g-command">{{ show(d('command')) }}</span></div>
      <div class="small">
        exit code: <strong>{{ show(d('exit_code')) }}</strong>;
        timed out: <strong :class="d('timed_out') === true ? 'fail' : ''">{{ d('timed_out') === true ? 'true' : d('timed_out') === false ? 'false' : show(d('timed_out')) }}</strong>
      </div>
      <div class="small muted">output</div>
      <pre class="g-output">{{ typeof d('output') === 'string' ? d('output') : show(d('output')) }}</pre>
    </template>

    <template v-else-if="shape === 'trace_check'">
      <table class="g-assertions">
        <thead><tr><th>assertion</th><th>result</th><th>reason</th></tr></thead>
        <tbody>
          <tr v-for="(a, i) in assertions" :key="i">
            <td class="mono">{{ show(a.assertion) }}</td>
            <td :class="a.passed === true ? 'pass' : 'fail'">{{ a.passed === true ? 'passed' : 'failed' }}</td>
            <td>{{ show(a.reason) }}</td>
          </tr>
        </tbody>
      </table>
    </template>

    <template v-else-if="shape === 'llm_judge'">
      <div class="small">
        pass rule: <strong>{{ show(d('pass_rule')) }}</strong>;
        judge model id: <span class="mono">{{ result.judge_model_id ?? 'n/a' }}</span>;
        judge prompt hash: <span class="mono">{{ result.judge_prompt_hash ?? 'n/a' }}</span>
      </div>
      <table class="g-criteria">
        <thead><tr><th>criterion</th><th>met</th><th>evidence</th></tr></thead>
        <tbody>
          <tr v-for="(c, i) in criteria" :key="i">
            <td class="mono">{{ show(c.id) }}<span v-if="typeof c.criterion === 'string'" class="muted"> {{ c.criterion }}</span></td>
            <td :class="c.met === true ? 'pass' : 'fail'">{{ c.met === true ? 'met' : 'NOT met' }}</td>
            <td>{{ c.evidence === undefined ? 'n/a' : show(c.evidence) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="small muted">Judge reasoning (verbatim)</div>
      <pre v-if="result.reasoning !== null" class="g-reasoning">{{ result.reasoning }}</pre>
      <div v-else class="small muted">(no reasoning recorded)</div>
      <details v-if="judgedInputs.length" class="g-inputs">
        <summary>Judged inputs ({{ judgedInputs.length }})</summary>
        <div v-for="(inp, i) in judgedInputs" :key="i">
          <div class="small muted mono">{{ show(inp.name) }}</div>
          <pre>{{ typeof inp.text === 'string' ? inp.text : show(inp.text) }}</pre>
        </div>
      </details>
    </template>

    <template v-else>
      <div class="small muted">details (unrecognised shape, printed as recorded)</div>
      <pre class="g-json">{{ pretty(result.details) }}</pre>
      <template v-if="result.reasoning !== null">
        <div class="small muted">reasoning (verbatim)</div>
        <pre class="g-reasoning">{{ result.reasoning }}</pre>
      </template>
    </template>

    <details v-if="rest" class="g-rest">
      <summary>Other recorded fields</summary>
      <pre>{{ pretty(rest) }}</pre>
    </details>
  </div>
</template>

<style scoped>
.grader { margin: 8px 0; }
.grader-head { gap: 12px; margin-bottom: 6px; }
.grader-verdict { font-size: 15px; }
.side-by-side { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 4px; }
.grader pre { background: var(--bg-soft); border: 1px solid var(--line); border-radius: 4px; padding: 6px 8px; margin: 3px 0 6px; max-height: 360px; overflow: auto; }
.grader table { margin: 4px 0 8px; }
.grader details { margin-top: 6px; }
</style>
