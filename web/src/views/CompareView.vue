<script setup lang="ts">
// The comparison screen (cards/P4.md section 3 and 6). It renders the API payload verbatim: badges first, numbers after,
// every number that has an interval shown with it. It computes no statistic and decides no verdict. The only logic here is
// a consistency check on the payload (verdictLine) and display transforms (formatting, negating a sign for a sentence).
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api, ApiError } from '../api/client';
import type { AggregateBlock, CategoryBlock, ComparePayload, ExperimentDetail, MetricBlock, MetricComparison, PerTaskRow, Verdict } from '../api/types';
import CountUp from '../components/CountUp.vue';
import DataTable from '../components/DataTable.vue';
import Interval from '../components/Interval.vue';
import Skeleton from '../components/Skeleton.vue';
import { describeAxis, type AxisDescription } from '../lib/axis';
import { FAILURE_CATEGORIES, FAILURE_RULE } from '../lib/failures';
import { num, usd } from '../lib/format';
import { useAppStore } from '../stores/app';

const props = defineProps<{ id: string }>();
const route = useRoute();
const store = useAppStore();

// ---------------------------------------------------------------- verdict rendering (the mandatory tested behaviour)

const clean = (x: number): number => Math.round(x * 1e12) / 1e12;

/** Same rounding as api/src/stats/compare.ts noiseRule. A consistency check on the payload only: the API decides the verdict. */
function intervalContainsZero(low: number, high: number): boolean {
  return clean(low) <= 0 && clean(high) >= 0;
}

type VerdictKind = 'noise' | 'a_better' | 'b_better' | 'insufficient' | 'inconsistent';
interface VerdictView {
  kind: VerdictKind;
  /** The full sentence for a card. */
  text: string;
  /** The short word for a table row. */
  word: string;
}
interface VerdictInput {
  verdict: Verdict | 'insufficient_data';
  delta: number | null;
  ci_low: number | null;
  ci_high: number | null;
  reason?: string;
}

function verdictLine(block: VerdictInput): VerdictView {
  const v = block.verdict;
  if (v === 'insufficient_data') {
    return { kind: 'insufficient', text: `insufficient data: ${block.reason ?? 'the API gave no reason'}`, word: 'insufficient data' };
  }
  const { delta, ci_low: lo, ci_high: hi } = block;
  const inconsistent = (): VerdictView => ({
    kind: 'inconsistent',
    text: `payload inconsistent: verdict ${String(v)} but interval [${num(lo)}, ${num(hi)}]`,
    word: 'payload inconsistent',
  });
  if (lo === null || hi === null) return inconsistent();
  const zero = intervalContainsZero(lo, hi);
  if (v === 'noise') {
    return zero ? { kind: 'noise', text: 'noise: the interval contains 0', word: 'noise' } : inconsistent();
  }
  if (zero || delta === null) return inconsistent();
  if (v === 'A_better' && delta > 0 && clean(lo) > 0) {
    return { kind: 'a_better', text: `A better by ${num(delta)} [${num(lo)}, ${num(hi)}]`, word: 'A better' };
  }
  if (v === 'B_better' && delta < 0 && clean(hi) < 0) {
    // delta is A - B everywhere; here the margin of B is shown, so the sign flips and the bounds swap.
    return { kind: 'b_better', text: `B better by ${num(-delta)} [${num(-hi)}, ${num(-lo)}]`, word: 'B better' };
  }
  return inconsistent();
}

// ---------------------------------------------------------------- loading

interface Issue {
  title: string;
  message: string;
  reasons: string[];
}

const issueOf = (title: string, e: unknown): Issue =>
  e instanceof ApiError ? { title, message: e.message, reasons: e.reasons } : { title, message: e instanceof Error ? e.message : String(e), reasons: [] };

const loading = ref(true);
const issues = ref<Issue[]>([]);
const experiment = ref<ExperimentDetail | null>(null);
const payload = ref<ComparePayload | null>(null);
const axis = ref<AxisDescription | null>(null);
const pickA = ref('');
const pickB = ref('');
let seq = 0;

const queryParam = (v: unknown): string | undefined => {
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === 'string' && first !== '' ? first : undefined;
};

async function load(): Promise<void> {
  const mine = ++seq;
  loading.value = true;
  issues.value = [];
  payload.value = null;
  axis.value = null;
  const a = queryParam(route.query.a);
  const b = queryParam(route.query.b);
  const [expRes, cmpRes] = await Promise.allSettled([api.getExperiment(props.id), api.compare(props.id, a, b)]);
  if (mine !== seq) return;

  const found: Issue[] = [];
  if (expRes.status === 'fulfilled') experiment.value = expRes.value;
  else {
    experiment.value = null;
    found.push(issueOf('Could not load the experiment', expRes.reason));
  }
  if (cmpRes.status === 'fulfilled') payload.value = cmpRes.value;
  else found.push(issueOf('Could not load the comparison', cmpRes.reason));

  const cfgs = experiment.value?.configs ?? [];
  pickA.value = payload.value?.config_a.id ?? a ?? cfgs[0]?.id ?? '';
  pickB.value = payload.value?.config_b.id ?? b ?? cfgs[1]?.id ?? '';
  issues.value = found;
  loading.value = false;

  const p = payload.value;
  if (!p) return;
  try {
    let all = await store.loadConfigs();
    let ca = all.find((c) => c.id === p.config_a.id);
    let cb = all.find((c) => c.id === p.config_b.id);
    if (!ca || !cb) {
      all = await store.loadConfigs(true);
      ca = all.find((c) => c.id === p.config_a.id);
      cb = all.find((c) => c.id === p.config_b.id);
    }
    if (mine !== seq) return;
    if (ca && cb) axis.value = describeAxis(ca, cb);
    else issues.value = [...issues.value, { title: 'Config diff unavailable', message: 'GET /configs does not list both configs of this comparison', reasons: [] }];
  } catch (e) {
    if (mine !== seq) return;
    issues.value = [...issues.value, issueOf('Config diff unavailable', e)];
  }
}

// A string key, so a route object that is replaced with the same id, a and b (for example a hash-only navigation) does not refetch.
watch(() => `${props.id}|${queryParam(route.query.a) ?? ''}|${queryParam(route.query.b) ?? ''}`, load, { immediate: true });

// ---------------------------------------------------------------- derived display values

const heading = computed(() => (payload.value ? `Compare: ${payload.value.config_a.name} (A) vs ${payload.value.config_b.name} (B)` : 'Compare'));
const samePick = computed(() => pickA.value !== '' && pickA.value === pickB.value);
const compareTo = computed(() => ({ path: `/experiments/${props.id}/compare`, query: { a: pickA.value, b: pickB.value } }));
const fewConfigs = computed(() => experiment.value !== null && experiment.value.configs.length < 2);

const CATEGORY_KEYS = ['memory_dependent', 'memory_distractor', 'neutral', 'honesty'] as const;
const categoryCards = computed<Array<{ key: (typeof CATEGORY_KEYS)[number]; block: CategoryBlock | null }>>(() =>
  CATEGORY_KEYS.map((key) => ({ key, block: payload.value?.by_category[key] ?? null })),
);

const includedRows = computed<PerTaskRow[]>(() => (payload.value?.per_task ?? []).filter((r) => !r.judge_excluded));
const excludedRows = computed<PerTaskRow[]>(() => (payload.value?.per_task ?? []).filter((r) => r.judge_excluded));

// Failure categories (P6): the counts are the API's, in the order of its rules. The only arithmetic is the sum of a column.
const failureRows = computed(() => {
  const f = payload.value?.failures;
  if (!f) return [];
  return FAILURE_CATEGORIES.map((key) => ({ key, a: f.a[key], b: f.b[key], rule: FAILURE_RULE[key] }));
});
const failureUncategorized = computed(() => payload.value?.failures.uncategorized ?? { a: 0, b: 0 });
const failureTotal = (side: 'a' | 'b'): number => failureRows.value.reduce((n, r) => n + r[side], 0) + failureUncategorized.value[side];

const policyClass = (p: ComparePayload['judge_policy_applied']): string => (p === 'trusted' ? 'badge-good' : p === 'flagged' ? 'badge-warn' : 'badge-bad');

interface MetricDef {
  key: string;
  label: string;
  digits: number;
  m: MetricComparison;
}
const metricDefs = computed<MetricDef[]>(() => {
  const p = payload.value;
  if (!p) return [];
  return [
    { key: 'cost', label: 'Cost (USD)', digits: 6, m: p.cost },
    { key: 'latency', label: 'Latency (ms)', digits: 1, m: p.latency_ms },
    { key: 'input-tokens', label: 'Input tokens', digits: 1, m: p.tokens.input },
    { key: 'output-tokens', label: 'Output tokens', digits: 1, m: p.tokens.output },
  ];
});

const deltaCiText = (ci: [number, number] | null, digits: number): string => (ci === null ? 'n/a' : `[${num(ci[0], digits)}, ${num(ci[1], digits)}]`);

// ---------------------------------------------------------------- charts (display only; hand-written SVG)

const CHART_W = 700;
const ROW_H = 34;
const BAR_X = 150;
const BAR_W = 270;
const TEXT_X = BAR_X + BAR_W + 12;

interface ChartRow {
  key: string;
  label: string;
  y: number;
  /** False when the mean or the interval is null: no bar. The text then says n/a (or the mean with "interval n/a"). */
  drawn: boolean;
  barW: number;
  whisker: { x1: number; x2: number } | null;
  noInterval: boolean;
  text: string;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const bound = (b: MetricBlock): number => Math.max(b.mean ?? 0, b.ci_high ?? 0);

function chartRows(side: 'a' | 'b'): ChartRow[] {
  const p = payload.value;
  if (!p) return [];
  const rows: ChartRow[] = [];
  const pass = side === 'a' ? p.aggregate.p_a : p.aggregate.p_b;
  rows.push({
    key: 'pass-rate',
    label: 'Pass rate',
    y: 0,
    drawn: pass !== null,
    barW: pass === null ? 0 : clamp01(pass) * BAR_W,
    whisker: null,
    noInterval: true,
    text: num(pass),
  });
  for (const d of metricDefs.value) {
    const mine = d.m[side];
    const scale = Math.max(bound(d.m.a), bound(d.m.b));
    const sx = (v: number): number => BAR_X + (scale > 0 ? clamp01(v / scale) : 0) * BAR_W;
    const drawn = mine.mean !== null && mine.ci_low !== null && mine.ci_high !== null;
    const text = drawn
      ? `${num(mine.mean, d.digits)} [${num(mine.ci_low, d.digits)}, ${num(mine.ci_high, d.digits)}]`
      : mine.mean !== null
        ? `${num(mine.mean, d.digits)} (interval n/a)`
        : 'n/a';
    rows.push({
      key: d.key,
      label: d.label,
      y: 0,
      drawn,
      barW: drawn ? sx(mine.mean as number) - BAR_X : 0,
      whisker: drawn ? { x1: sx(mine.ci_low as number), x2: sx(mine.ci_high as number) } : null,
      noInterval: false,
      text,
    });
  }
  return rows.map((r, i) => ({ ...r, y: 10 + i * ROW_H }));
}

const chartHeight = ROW_H * 5 + 20;
const chartA = computed(() => chartRows('a'));
const chartB = computed(() => chartRows('b'));

// Delta chart: horizontal axis fixed at -1..1, the unit of a pass-rate difference.
const D_X0 = 40;
const D_W = 520;
const dx = (v: number): number => D_X0 + ((Math.min(1, Math.max(-1, v)) + 1) / 2) * D_W;
const DELTA_TICKS = [-1, -0.5, 0, 0.5, 1];
</script>

<template>
  <div class="compare page">
    <header class="page-head">
      <div>
        <p class="crumb"><RouterLink :to="`/experiments/${id}`" data-testid="back-link">Back to the experiment</RouterLink></p>
        <h1 data-testid="heading">{{ heading }}</h1>
      </div>
      <div v-if="experiment" class="row pickers" data-testid="pickers">
        <label>
          A
          <select v-model="pickA" data-testid="pick-a">
            <option v-for="c in experiment.configs" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </label>
        <label>
          B
          <select v-model="pickB" data-testid="pick-b">
            <option v-for="c in experiment.configs" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </label>
        <RouterLink :to="compareTo" class="btn" data-testid="compare-link">Compare</RouterLink>
        <span v-if="samePick" class="muted small" data-testid="same-pick">A and B are the same config; pick 2 different configs.</span>
      </div>
    </header>

    <div v-for="(issue, i) in issues" :key="i" class="error" data-testid="api-error">
      <strong>{{ issue.title }}:</strong> {{ issue.message }}
      <ul v-if="issue.reasons.length > 0">
        <li v-for="(r, j) in issue.reasons" :key="j">{{ r }}</li>
      </ul>
    </div>

    <p v-if="fewConfigs" class="notice" data-testid="few-configs">This experiment has fewer than 2 configs, so there is nothing to compare.</p>

    <div v-if="loading" class="panel" data-testid="loading">
      <Skeleton variant="lines" :rows="5" />
      <p class="muted small">Loading the comparison...</p>
    </div>

    <template v-if="payload">
      <p v-if="payload.n_scored === 0" class="notice" data-testid="empty">No scored trials in this comparison yet. Every figure below is empty.</p>

      <!-- (2) badges first, numbers after: the caveats a reader must see before any number -->
      <section class="caveats" aria-label="Read before the numbers">
        <div class="row badges" data-testid="badges">
          <span class="badge" :class="payload.reliability === 'complete' ? 'badge-good' : 'badge-warn'" data-testid="badge-reliability">
            reliability: {{ payload.reliability }}<template v-if="payload.reliability === 'partial'"> ({{ payload.n_unfinished }} unfinished, {{ payload.n_excluded }} excluded)</template>
          </span>
          <span class="badge" :class="policyClass(payload.judge_policy_applied)" data-testid="badge-judge-policy">judge policy: {{ payload.judge_policy_applied }}</span>
          <span v-if="payload.judge_confidence === 'low'" class="badge badge-warn" data-testid="badge-judge-confidence">judge confidence: low</span>
          <span class="badge" :class="payload.rate_limit_affected_trials > 0 ? 'badge-warn' : ''" data-testid="badge-rate-limit">
            rate-limit affected trials: {{ payload.rate_limit_affected_trials }}
          </span>
        </div>
        <p v-if="payload.judge_excluded_tasks.length > 0" class="warn" data-testid="judge-excluded-tasks">
          Excluded by the judge policy: {{ payload.judge_excluded_tasks.join(', ') }}
        </p>
        <p class="muted mono counts" data-testid="counts">
          n_tasks {{ payload.n_tasks }}, n_trials_per_task {{ payload.n_trials_per_task }}, n_scored {{ payload.n_scored }}, n_excluded {{ payload.n_excluded }},
          n_unfinished {{ payload.n_unfinished }}, ci_method {{ payload.ci_method }}, stats_version {{ payload.stats_version }}
          <template v-if="payload.judge.kappa !== null">, judge kappa {{ num(payload.judge.kappa) }}</template>
        </p>
        <div v-if="payload.unpaired_tasks.length > 0" class="warn" data-testid="unpaired">
          Tasks not paired between A and B:
          <ul>
            <li v-for="u in payload.unpaired_tasks" :key="u.task_id"><span class="mono">{{ u.task_id }}</span>: {{ u.reason }}</li>
          </ul>
        </div>
      </section>

      <!-- (3) axis -->
      <p class="axis" data-testid="axis">
        <strong>Axis:</strong> <span data-testid="axis-label">{{ payload.axis ?? 'axis not stated' }}</span>
        <template v-if="axis">
          <span class="muted"> | config diff: </span>
          <span :class="axis.groups.length >= 2 ? 'fail' : ''" data-testid="axis-diff">{{ axis.text }}</span>
        </template>
      </p>

      <!-- (4) aggregate -->
      <section class="card aggregate" data-testid="aggregate">
        <h2>Aggregate</h2>
        <div class="agg-grid">
          <p class="stat"><span class="stat-label">A: <strong>{{ payload.config_a.name }}</strong> pass rate </span><span class="stat-value"><CountUp :value="payload.aggregate.p_a" /></span></p>
          <p class="stat"><span class="stat-label">B: <strong>{{ payload.config_b.name }}</strong> pass rate </span><span class="stat-value"><CountUp :value="payload.aggregate.p_b" /></span></p>
          <p class="stat stat-delta">
            <span class="stat-label">delta (A - B) </span>
            <Interval :value="payload.aggregate.delta" :low="payload.aggregate.ci_low" :high="payload.aggregate.ci_high" hero bar />
          </p>
          <div class="agg-verdict">
            <template v-for="v in [verdictLine(payload.aggregate)]" :key="v.kind">
              <div v-if="v.kind === 'inconsistent'" class="warn" data-testid="verdict-aggregate" data-kind="inconsistent">{{ v.text }}</div>
              <p v-else class="verdict" :class="{ 'verdict-pill': v.kind !== 'insufficient' }" :data-kind="v.kind" data-testid="verdict-aggregate">{{ v.text }}</p>
            </template>
            <p class="min-detectable">
              min detectable: <span class="num mono">{{ num(payload.aggregate.min_detectable) }}</span>
              <span class="muted small"> the smallest effect this experiment could have detected</span>
            </p>
          </div>
        </div>
        <div class="agg-foot">
          <p class="muted small">intervals in the tables are A - B; the sentence states the margin of the better config</p>
          <p class="muted small mono">resamples {{ payload.aggregate.resamples }}, seed {{ payload.aggregate.seed }}</p>
        </div>
      </section>

      <!-- (5) by category -->
      <section>
        <div class="section-title"><h2>By category</h2></div>
        <div class="cards categories" data-testid="categories">
          <section v-for="c in categoryCards" :key="c.key" class="card category" :data-testid="`category-${c.key}`">
            <h3 class="mono">{{ c.key }}</h3>
            <p v-if="c.block === null" class="muted small">no tasks of this category in this experiment</p>
            <template v-else>
              <p class="small muted">n_tasks {{ c.block.n_tasks }}</p>
              <p class="small">pass rate A <span class="num mono">{{ num(c.block.p_a) }}</span>, B <span class="num mono">{{ num(c.block.p_b) }}</span></p>
              <p class="cat-delta"><span class="small muted">delta (A - B) </span><Interval :value="c.block.delta" :low="c.block.ci_low" :high="c.block.ci_high" bar /></p>
              <template v-for="v in [verdictLine(c.block)]" :key="v.kind">
                <div v-if="v.kind === 'inconsistent'" class="warn" data-kind="inconsistent">{{ v.text }}</div>
                <p v-else class="verdict" :data-kind="v.kind">{{ v.text }}</p>
              </template>
              <p v-if="c.block.reason && c.block.verdict !== 'insufficient_data'" class="muted small">{{ c.block.reason }}</p>
            </template>
          </section>
        </div>
      </section>

      <!-- (6) secondary tests -->
      <section class="panel secondary">
        <h2>Secondary tests</h2>
        <p data-testid="sign-test">
          Sign test: A won on {{ payload.sign_test.a_wins }} tasks, B won on {{ payload.sign_test.b_wins }}, {{ payload.sign_test.ties }} tied (exact p =
          {{ num(payload.sign_test.p_value) }})
        </p>
        <p v-if="payload.mcnemar" data-testid="mcnemar">
          McNemar: a_only {{ payload.mcnemar.a_only }}, b_only {{ payload.mcnemar.b_only }}, n_discordant {{ payload.mcnemar.n_discordant }}, p_value
          {{ num(payload.mcnemar.p_value) }}
        </p>
        <p v-else class="muted" data-testid="mcnemar">McNemar not computed: {{ payload.mcnemar_omitted ?? 'no reason given' }}</p>
      </section>

      <!-- (7) per task -->
      <section>
        <div class="section-title"><h2>Per task</h2></div>
        <DataTable data-testid="per-task-table" max-height="720px">
          <template #caption>
            <p class="dt-caption" data-testid="direction-caption">
              direction only: per-task intervals resample the N trials of a single task and no multiple-comparison correction is applied
            </p>
          </template>
          <thead>
            <tr>
              <th>task</th><th>category</th><th class="num">n_a</th><th class="num">n_b</th><th class="num">rate_a</th><th class="num">rate_b</th>
              <th>delta (A - B)</th><th>verdict</th><th>failure A</th><th>failure B</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in includedRows" :key="r.task_id" :data-testid="`task-row-${r.task_id}`">
              <td class="mono">{{ r.task_id }}</td>
              <td class="small muted">{{ r.category }}</td>
              <td class="num">{{ r.n_a }}</td>
              <td class="num">{{ r.n_b }}</td>
              <td class="num">{{ num(r.rate_a) }}</td>
              <td class="num">{{ num(r.rate_b) }}</td>
              <td><Interval :value="r.delta" :low="r.ci_low" :high="r.ci_high" bar /></td>
              <td class="verdict-word" :class="verdictLine(r).kind === 'inconsistent' ? 'fail' : ''" :data-kind="verdictLine(r).kind">{{ verdictLine(r).word }}</td>
              <td class="mono small" :data-testid="`failure-a-${r.task_id}`">{{ r.failure_category_a ?? '-' }}</td>
              <td class="mono small" :data-testid="`failure-b-${r.task_id}`">{{ r.failure_category_b ?? '-' }}</td>
            </tr>
            <tr v-if="includedRows.length === 0"><td colspan="10" class="muted">no tasks in the headline comparison</td></tr>
          </tbody>
        </DataTable>
      </section>

      <section v-if="excludedRows.length > 0">
        <div class="section-title"><h3>Excluded by the judge policy (not in any headline figure)</h3></div>
        <DataTable data-testid="excluded-table">
          <thead>
            <tr>
              <th>task</th><th>category</th><th class="num">n_a</th><th class="num">n_b</th><th class="num">rate_a</th><th class="num">rate_b</th>
              <th>delta (A - B)</th><th>verdict</th><th>failure A</th><th>failure B</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in excludedRows" :key="r.task_id" :data-testid="`excluded-row-${r.task_id}`">
              <td class="mono">{{ r.task_id }}</td>
              <td class="small muted">{{ r.category }}</td>
              <td class="num">{{ r.n_a }}</td>
              <td class="num">{{ r.n_b }}</td>
              <td class="num">{{ num(r.rate_a) }}</td>
              <td class="num">{{ num(r.rate_b) }}</td>
              <td><Interval :value="r.delta" :low="r.ci_low" :high="r.ci_high" bar /></td>
              <td class="verdict-word" :class="verdictLine(r).kind === 'inconsistent' ? 'fail' : ''" :data-kind="verdictLine(r).kind">{{ verdictLine(r).word }}</td>
              <td class="mono small">{{ r.failure_category_a ?? '-' }}</td>
              <td class="mono small">{{ r.failure_category_b ?? '-' }}</td>
            </tr>
          </tbody>
        </DataTable>
      </section>

      <!-- (7b) failure categories -->
      <section>
        <div class="section-title"><h2>Failure categories</h2></div>
        <p class="muted small caption" data-testid="failures-caption">
          Why the failed trials failed: pure rules over the trace and the grader results, the first matching rule wins. Counts are failed trials
          of the tasks in the headline comparison. A count is a number of trials, not an effect, and has no interval.
        </p>
        <p v-if="failureUncategorized.a + failureUncategorized.b > 0" class="warn" data-testid="failures-uncategorized">
          {{ failureUncategorized.a }} failed trial(s) of A and {{ failureUncategorized.b }} of B have no category yet: run npm run failures:backfill in the api container.
        </p>
        <DataTable data-testid="failures-table">
          <thead>
            <tr><th>category</th><th class="num">A: {{ payload.config_a.name }}</th><th class="num">B: {{ payload.config_b.name }}</th><th>rule</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in failureRows" :key="r.key" :data-testid="`failure-row-${r.key}`">
              <td class="mono">{{ r.key }}</td>
              <td class="num" :class="r.a === 0 ? 'muted' : ''" :data-testid="`failure-a-count-${r.key}`">{{ r.a }}</td>
              <td class="num" :class="r.b === 0 ? 'muted' : ''" :data-testid="`failure-b-count-${r.key}`">{{ r.b }}</td>
              <td class="small muted wrap">{{ r.rule }}</td>
            </tr>
            <tr v-if="failureUncategorized.a + failureUncategorized.b > 0" data-testid="failure-row-uncategorized">
              <td class="mono">uncategorized</td>
              <td class="num">{{ failureUncategorized.a }}</td>
              <td class="num">{{ failureUncategorized.b }}</td>
              <td class="small muted wrap">no category stored for this trial yet</td>
            </tr>
            <tr data-testid="failure-row-total" class="total-row">
              <td><strong>failed trials</strong></td>
              <td class="num" data-testid="failure-total-a"><strong>{{ failureTotal('a') }}</strong></td>
              <td class="num" data-testid="failure-total-b"><strong>{{ failureTotal('b') }}</strong></td>
              <td></td>
            </tr>
          </tbody>
        </DataTable>
      </section>

      <!-- (8) quality, cost, latency, tokens -->
      <section>
        <div class="section-title"><h2>Quality, cost, latency, tokens</h2></div>
        <DataTable data-testid="metrics-table">
          <thead>
            <tr><th>metric</th><th>A mean [ci_low, ci_high]</th><th>B mean [ci_low, ci_high]</th><th>A - B interval</th></tr>
          </thead>
          <tbody>
            <tr data-testid="metric-pass-rate">
              <td>Pass rate</td>
              <td class="num">{{ num(payload.aggregate.p_a) }}</td>
              <td class="num">{{ num(payload.aggregate.p_b) }}</td>
              <td><Interval :value="payload.aggregate.delta" :low="payload.aggregate.ci_low" :high="payload.aggregate.ci_high" /></td>
            </tr>
            <tr v-for="d in metricDefs" :key="d.key" :data-testid="`metric-${d.key}`">
              <td>{{ d.label }}</td>
              <td><Interval :value="d.m.a.mean" :low="d.m.a.ci_low" :high="d.m.a.ci_high" :digits="d.digits" /></td>
              <td><Interval :value="d.m.b.mean" :low="d.m.b.ci_low" :high="d.m.b.ci_high" :digits="d.digits" /></td>
              <td class="mono small">{{ deltaCiText(d.m.delta_ci, d.digits) }}</td>
            </tr>
          </tbody>
        </DataTable>
        <p class="muted small caption">The pass rates have no interval of their own in the payload; the interval on the pass-rate row is the one of the aggregate delta.</p>
      </section>

      <!-- (9) charts -->
      <section class="panel">
        <div class="section-title">
          <h2>Charts</h2>
          <span class="muted small">Display only. Delta is A - B: positive means A passed more tasks.</span>
        </div>
        <svg
          class="chart"
          data-testid="chart-delta"
          role="img"
          :viewBox="`0 0 ${CHART_W} 100`"
          :aria-label="`Delta of pass rate, A minus B: ${num(payload.aggregate.delta)} with interval ${num(payload.aggregate.ci_low)} to ${num(payload.aggregate.ci_high)}`"
        >
          <title>Delta of pass rate (A - B) with its 95 percent interval, on an axis from -1 to 1</title>
          <text :x="D_X0" y="16" class="lbl">
            delta (A - B) {{ num(payload.aggregate.delta) }} [{{ num(payload.aggregate.ci_low) }}, {{ num(payload.aggregate.ci_high) }}]
          </text>
          <line :x1="D_X0" y1="56" :x2="D_X0 + D_W" y2="56" class="axis-line" />
          <g v-for="t in DELTA_TICKS" :key="t">
            <line :x1="dx(t)" y1="52" :x2="dx(t)" y2="60" class="axis-line" />
            <text :x="dx(t)" y="76" text-anchor="middle" class="lbl small-lbl">{{ t }}</text>
          </g>
          <line :x1="dx(0)" y1="30" :x2="dx(0)" y2="62" class="zero-line" data-testid="zero-line" />
          <g v-if="payload.aggregate.ci_low !== null && payload.aggregate.ci_high !== null" data-testid="delta-whisker">
            <line :x1="dx(payload.aggregate.ci_low)" y1="46" :x2="dx(payload.aggregate.ci_high)" y2="46" class="whisker" />
            <line :x1="dx(payload.aggregate.ci_low)" y1="40" :x2="dx(payload.aggregate.ci_low)" y2="52" class="whisker" />
            <line :x1="dx(payload.aggregate.ci_high)" y1="40" :x2="dx(payload.aggregate.ci_high)" y2="52" class="whisker" />
          </g>
          <circle v-if="payload.aggregate.delta !== null" :cx="dx(payload.aggregate.delta)" cy="46" r="4" class="dot" data-testid="delta-dot" />
          <text v-else :x="D_X0" y="46" class="lbl">delta n/a</text>
        </svg>

        <div class="charts">
          <svg
            v-for="side in ['a', 'b'] as const"
            :key="side"
            class="chart"
            :data-testid="`chart-${side}`"
            role="img"
            :viewBox="`0 0 ${CHART_W} ${chartHeight}`"
            :aria-label="`Config ${side.toUpperCase()}: ${side === 'a' ? payload.config_a.name : payload.config_b.name}. Bars are means with 95 percent interval whiskers; A and B share a scale per metric.`"
          >
            <title>Config {{ side.toUpperCase() }}: {{ side === 'a' ? payload.config_a.name : payload.config_b.name }}, means with 95 percent interval whiskers</title>
            <g v-for="r in side === 'a' ? chartA : chartB" :key="r.key" :data-testid="`row-${r.key}`">
              <text x="0" :y="r.y + 14" class="lbl">{{ r.label }}</text>
              <rect :x="BAR_X" :y="r.y + 2" :width="BAR_W" height="18" rx="3" class="bar-track" />
              <template v-if="r.drawn">
                <rect :x="BAR_X" :y="r.y + 2" :width="r.barW" height="18" rx="3" :class="side === 'a' ? 'bar-a' : 'bar-b'" :data-testid="`bar-${r.key}`" />
                <g v-if="r.whisker" :data-testid="`whisker-${r.key}`" class="whisker-group">
                  <line :x1="r.whisker.x1" :y1="r.y + 11" :x2="r.whisker.x2" :y2="r.y + 11" class="whisker" />
                  <line :x1="r.whisker.x1" :y1="r.y + 5" :x2="r.whisker.x1" :y2="r.y + 17" class="whisker" />
                  <line :x1="r.whisker.x2" :y1="r.y + 5" :x2="r.whisker.x2" :y2="r.y + 17" class="whisker" />
                </g>
              </template>
              <text :x="TEXT_X" :y="r.y + 14" class="lbl mono-lbl">{{ r.text }}</text>
              <text v-if="r.noInterval" :x="BAR_X" :y="r.y + 31" class="lbl small-lbl" data-testid="no-interval-note">no interval in payload</text>
            </g>
          </svg>
        </div>
      </section>

      <!-- (10) downloads -->
      <div class="downloads row">
        <a class="btn" :href="api.compareCsvUrl(id, payload.config_a.id, payload.config_b.id)" download data-testid="csv-link">Download compare.csv</a>
        <span v-if="payload.comparison_run_id" class="muted small mono" data-testid="run-id">comparison_run_id {{ payload.comparison_run_id }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pickers { gap: var(--space-3); }
.pickers label { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--fs-12); font-weight: var(--fw-strong); color: var(--text-muted); }
.pickers select { max-width: 260px; }

.caveats { display: flex; flex-direction: column; gap: var(--space-2); }
.badges { gap: var(--space-2); }
.badges .badge { height: 26px; padding: 0 12px; font-size: var(--fs-13); }
.counts { font-size: var(--fs-12); line-height: 1.6; }
.axis { font-size: var(--fs-13); }

.aggregate { padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-4); }
.agg-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.2fr) auto; gap: var(--space-5); align-items: start; }
.agg-grid .stat { gap: var(--space-1); }
.stat-delta { gap: var(--space-1); }
.agg-verdict { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-3); padding-left: var(--space-5); border-left: 1px solid var(--border); }
.agg-verdict .verdict-pill { font-size: var(--fs-28); white-space: nowrap; }
.agg-verdict .warn { font-size: var(--fs-14); font-weight: var(--fw-strong); }
.min-detectable { font-size: var(--fs-13); }
.agg-foot { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--space-2) var(--space-5); padding-top: var(--space-3); border-top: 1px solid var(--border); }

.categories { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.category { display: flex; flex-direction: column; gap: var(--space-2); }
.category h3 { font-size: var(--fs-13); margin-bottom: var(--space-1); }
.cat-delta { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-1); }
.cat-delta :deep(.iv-with-bar) { display: block; }
.cat-delta :deep(.iv-bar) { display: block; margin: 6px 0 0; }

.secondary { display: flex; flex-direction: column; gap: var(--space-2); font-size: var(--fs-13); }
.secondary h2 { margin-bottom: var(--space-1); }

.verdict-word { font-size: var(--fs-12); font-weight: var(--fw-strong); }
.verdict-word[data-kind='noise'] { color: var(--noise-text); }
.verdict-word[data-kind='a_better'], .verdict-word[data-kind='b_better'] { color: var(--info-text); }
.verdict-word[data-kind='insufficient'] { color: var(--text-muted); font-weight: var(--fw-regular); }
.total-row td { background: var(--surface-2); }
.caption { margin: 0 0 var(--space-3); max-width: 110ch; }
.caption:last-child { margin: var(--space-2) 0 0; }

.chart { display: block; width: 100%; max-width: 700px; margin: var(--space-3) 0; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-control); }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(520px, 1fr)); gap: var(--space-4); }
.charts .chart { max-width: 760px; margin: 0; }
.lbl { font-family: var(--font-ui); font-size: 12px; fill: var(--text); }
.mono-lbl { font-family: var(--font-mono); font-size: 12px; }
.small-lbl { font-size: 10px; fill: var(--text-muted); }
.axis-line { stroke: var(--border-strong); stroke-width: 1; }
.zero-line { stroke: var(--text-muted); stroke-width: 1.5; stroke-dasharray: 3 3; }
.whisker { stroke: var(--text); stroke-width: 1.5; }
.dot { fill: var(--accent); }
.bar-track { fill: var(--surface-1); }
.bar-a { fill: var(--chart-a); }
.bar-b { fill: var(--chart-b); }
.downloads { gap: var(--space-4); }

@media (max-width: 900px) {
  .categories { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 1240px) {
  .agg-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .agg-verdict { grid-column: 1 / -1; padding-left: 0; border-left: 0; padding-top: var(--space-4); border-top: 1px solid var(--border); }
}
</style>
