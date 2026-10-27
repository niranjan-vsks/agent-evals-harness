<script setup lang="ts">
// The home dashboard (cards/P8.md section 6): the state of the whole evaluation effort on 1 page. It renders GET /summary
// verbatim and computes no statistic: the verdicts are the API's persisted comparisons, the pass rates are the API's macro
// averages. The only logic here is a consistency check on each verdict (the same check as the Compare page), the pick of the
// best config for 1 tile, and display transforms (sorting, scaling a chart, formatting).
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, ApiError } from '../api/client';
import type { FailureCategory, SummaryComparison, SummaryConfig, SummaryExperiment, SummaryPayload } from '../api/types';
import CountUp from '../components/CountUp.vue';
import DataTable from '../components/DataTable.vue';
import EmptyState from '../components/EmptyState.vue';
import Interval from '../components/Interval.vue';
import Skeleton from '../components/Skeleton.vue';
import StatusChip from '../components/StatusChip.vue';
import { FAILURE_CATEGORIES, FAILURE_RULE } from '../lib/failures';
import { num, when } from '../lib/format';

// ---------------------------------------------------------------- loading (once on mount, then only on Refresh: card 10.3)

interface Issue {
  message: string;
  reasons: string[];
}

const summary = ref<SummaryPayload | null>(null);
const loading = ref(true);
const issue = ref<Issue | null>(null);
const loadedAt = ref<string | null>(null);
let seq = 0;

async function load(): Promise<void> {
  const mine = ++seq;
  loading.value = true;
  try {
    const s = await api.summary();
    if (mine !== seq) return;
    summary.value = s;
    issue.value = null;
    loadedAt.value = new Date().toISOString();
  } catch (e) {
    if (mine !== seq) return;
    issue.value = e instanceof ApiError ? { message: e.message, reasons: e.reasons } : { message: e instanceof Error ? e.message : String(e), reasons: [] };
  } finally {
    if (mine === seq) loading.value = false;
  }
}

onMounted(load);

const isEmpty = computed(() => summary.value !== null && summary.value.totals.experiments === 0);

// ---------------------------------------------------------------- verdicts (the same consistency check as CompareView)

const clean = (x: number): number => Math.round(x * 1e12) / 1e12;
/** Same rounding as api/src/stats/compare.ts noiseRule. A check on the stored payload only: the API decided the verdict. */
const containsZero = (low: number, high: number): boolean => clean(low) <= 0 && clean(high) >= 0;

type VerdictKind = 'noise' | 'a_better' | 'b_better' | 'insufficient' | 'inconsistent';

function verdictOf(c: SummaryComparison): { kind: VerdictKind; word: string; detail: string } {
  if (c.verdict === 'insufficient_data') return { kind: 'insufficient', word: 'insufficient data', detail: 'too few paired tasks for an interval' };
  const { delta, ci_low: lo, ci_high: hi } = c;
  const inconsistent = { kind: 'inconsistent' as const, word: 'payload inconsistent', detail: `verdict ${String(c.verdict)} but interval [${num(lo)}, ${num(hi)}]` };
  if (lo === null || hi === null) return inconsistent;
  const zero = containsZero(lo, hi);
  if (c.verdict === 'noise') return zero ? { kind: 'noise', word: 'noise', detail: 'the interval contains 0' } : inconsistent;
  if (zero || delta === null) return inconsistent;
  if (c.verdict === 'A_better' && delta > 0 && clean(lo) > 0) return { kind: 'a_better', word: 'A better', detail: `by ${num(delta)} [${num(lo)}, ${num(hi)}]` };
  // delta is A - B; the margin of B is shown, so the sign flips and the bounds swap.
  if (c.verdict === 'B_better' && delta < 0 && clean(hi) < 0) return { kind: 'b_better', word: 'B better', detail: `by ${num(-delta)} [${num(-hi)}, ${num(-lo)}]` };
  return inconsistent;
}

const verdicts = computed(() => (summary.value?.latest_comparisons ?? []).map((c) => ({ c, v: verdictOf(c) })));
const policyClass = (p: SummaryComparison['judge_policy_applied']): string => (p === 'trusted' ? 'badge-good' : p === 'flagged' ? 'badge-warn' : 'badge-bad');
const compareLink = (c: SummaryComparison) => ({ path: `/experiments/${c.experiment_id}/compare`, query: { a: c.config_a_id, b: c.config_b_id } });

// ---------------------------------------------------------------- tiles

/** Card 10.1: the highest pass rate; a tie goes to the config with more done trials, then to the name. */
function bestConfig(configs: SummaryConfig[]): SummaryConfig | null {
  const rated = configs.filter((c) => c.pass_rate !== null);
  rated.sort((x, y) => (y.pass_rate as number) - (x.pass_rate as number) || y.trials_done - x.trials_done || x.name.localeCompare(y.name));
  return rated[0] ?? null;
}
const best = computed(() => bestConfig(summary.value?.configs ?? []));

// ---------------------------------------------------------------- pass rate per config (horizontal bars, SVG)

const rated = computed(() => (summary.value?.configs ?? []).filter((c) => c.pass_rate !== null).sort((x, y) => (y.pass_rate as number) - (x.pass_rate as number) || x.name.localeCompare(y.name)));
const unrated = computed(() => (summary.value?.configs.length ?? 0) - rated.value.length);

const BARS_W = 560;
const BAR_ROW = 30;
const BAR_X = 176;
const BAR_LEN = 300;
const NAME_CHARS = 24;
const shortName = (s: string): string => (s.length > NAME_CHARS ? `${s.slice(0, NAME_CHARS - 3)}...` : s);
const barsHeight = computed(() => rated.value.length * BAR_ROW + 8);

// ---------------------------------------------------------------- mean cost vs pass rate (scatter, SVG)

const SC_W = 560;
const SC_H = 300;
const SC = { left: 52, right: 20, top: 16, bottom: 44 };
const plotted = computed(() => rated.value.filter((c) => c.mean_cost_usd !== null));
const costMax = computed(() => {
  const m = Math.max(0, ...plotted.value.map((c) => c.mean_cost_usd as number));
  return m > 0 ? m * 1.1 : 1;
});
const sx = (cost: number): number => SC.left + (cost / costMax.value) * (SC_W - SC.left - SC.right);
const sy = (rate: number): number => SC.top + (1 - rate) * (SC_H - SC.top - SC.bottom);
const costTicks = computed(() => [0, costMax.value / 2, costMax.value]);
const costDigits = computed(() => (costMax.value >= 1 ? 2 : costMax.value >= 0.01 ? 4 : 6));
const points = computed(() =>
  plotted.value.map((c) => {
    const x = sx(c.mean_cost_usd as number);
    // Labels sit right of the point, or left of it near the right edge, so they stay inside the plot.
    const right = x < SC_W - 150;
    return { c, x, y: sy(c.pass_rate as number), lx: right ? x + 8 : x - 8, anchor: right ? 'start' : 'end' };
  }),
);

// ---------------------------------------------------------------- failures (a bar list) and recent experiments

const failureRows = computed(() => {
  const f = summary.value?.failures ?? {};
  const rows: Array<{ key: FailureCategory | 'uncategorized'; n: number; rule: string }> = FAILURE_CATEGORIES.map((key) => ({ key, n: f[key] ?? 0, rule: FAILURE_RULE[key] }));
  if ((f.uncategorized ?? 0) > 0) rows.push({ key: 'uncategorized', n: f.uncategorized as number, rule: 'no category stored for this trial yet' });
  return rows.filter((r) => r.n > 0).sort((x, y) => y.n - x.n);
});
const failureTotal = computed(() => failureRows.value.reduce((n, r) => n + r.n, 0));
const failureMax = computed(() => Math.max(1, ...failureRows.value.map((r) => r.n)));
const zeroCategories = computed(() => FAILURE_CATEGORIES.length - failureRows.value.filter((r) => r.key !== 'uncategorized').length);

const finished = (e: SummaryExperiment): number => e.progress.done + e.progress.errored + e.progress.cancelled;
</script>

<template>
  <div class="overview page">
    <header class="page-head">
      <div>
        <h1>Overview</h1>
        <p class="page-sub">
          Every number is read from stored trials and persisted comparisons; nothing on this page is recomputed. A verdict shows here only once its
          comparison has been stored.
        </p>
      </div>
      <div class="row refresh">
        <span v-if="loadedAt" class="muted small mono" data-testid="loaded-at">loaded {{ when(loadedAt) }}</span>
        <button type="button" :disabled="loading" data-testid="refresh" @click="load">{{ loading && summary ? 'Refreshing...' : 'Refresh' }}</button>
      </div>
    </header>

    <div v-if="issue" class="error" data-testid="api-error">
      <strong>Could not load the summary:</strong> {{ issue.message }}
      <ul v-if="issue.reasons.length > 0">
        <li v-for="(r, i) in issue.reasons" :key="i">{{ r }}</li>
      </ul>
    </div>

    <div v-if="loading && !summary" class="panel" data-testid="loading">
      <Skeleton variant="lines" :rows="4" />
      <p class="muted small">Loading the summary...</p>
    </div>

    <EmptyState v-if="isEmpty" title="No experiments yet." data-testid="empty">
      An experiment runs 2 or more configs over the same tasks and says whether one beats the other. Start by creating a config, then an experiment from 2 of
      them.
      <span class="empty-cta"><RouterLink to="/configs" class="btn primary" data-testid="create-config">Create a config</RouterLink></span>
    </EmptyState>

    <template v-if="summary && !isEmpty">
      <!-- row 1: the totals -->
      <section class="tiles" aria-label="Totals" data-testid="tiles">
        <div class="tile" data-testid="tile-experiments">
          <span class="stat-label">Experiments</span>
          <span class="stat-value"><CountUp :value="summary.totals.experiments" :digits="0" /></span>
          <span class="tile-sub">{{ summary.totals.configs }} configs, {{ summary.totals.models }} models, {{ summary.totals.harnesses }} harnesses</span>
        </div>
        <div class="tile" data-testid="tile-trials">
          <span class="stat-label">Trials done</span>
          <span class="stat-value"><CountUp :value="summary.totals.trials_done" :digits="0" /></span>
          <span class="tile-sub">graded or ungraded, all experiments</span>
        </div>
        <div class="tile" data-testid="tile-spend">
          <span class="stat-label">Spend</span>
          <span class="stat-value"><CountUp :value="summary.totals.spend_usd" :digits="2" unit=" USD" /></span>
          <span class="tile-sub mono">{{ num(summary.totals.spend_usd, 6) }} USD over done trials</span>
        </div>
        <div class="tile tile-best" data-testid="tile-best">
          <span class="stat-label">Best pass rate</span>
          <span class="stat-value"><CountUp :value="best?.pass_rate ?? null" /></span>
          <span class="tile-sub" :title="best?.name">{{ best ? best.name : 'no graded trial yet' }}</span>
        </div>
        <div class="tile" data-testid="tile-errored">
          <span class="stat-label">Errored trials</span>
          <span class="stat-value" :class="{ 'is-fail': summary.totals.trials_errored > 0 }"><CountUp :value="summary.totals.trials_errored" :digits="0" /></span>
          <span class="tile-sub">never scored, counted apart</span>
        </div>
        <div class="tile" data-testid="tile-tasks">
          <span class="stat-label">Tasks</span>
          <span class="stat-value"><CountUp :value="summary.totals.tasks_current" :digits="0" /></span>
          <span class="tile-sub">current versions</span>
        </div>
      </section>

      <!-- row 2: latest verdicts, from comparison_run only -->
      <section>
        <div class="section-title">
          <h2>Latest verdicts</h2>
          <span class="small muted">newest stored comparison of each pair; delta is A - B on the pass rate</span>
        </div>
        <EmptyState v-if="verdicts.length === 0" title="No stored comparison yet." data-testid="no-verdicts">
          A verdict appears here once a comparison is persisted: download an experiment's export, or call its compare endpoint with persist=1.
        </EmptyState>
        <ol v-else class="verdicts panel panel-flush" data-testid="verdicts">
          <li v-for="{ c, v } in verdicts" :key="c.comparison_run_id" class="verdict-row" :data-testid="`verdict-${c.comparison_run_id}`">
            <div class="vr-what">
              <RouterLink :to="`/experiments/${c.experiment_id}`" class="vr-exp">{{ c.experiment_name }}</RouterLink>
              <p class="vr-pair">
                <span class="muted">A</span> <strong>{{ c.config_a_name }}</strong> <span class="muted">vs B</span> <strong>{{ c.config_b_name }}</strong>
              </p>
              <p class="muted small">axis: {{ c.axis ?? 'not stated' }}</p>
            </div>
            <div class="vr-delta">
              <span class="stat-label">delta (A - B)</span>
              <Interval :value="c.delta" :low="c.ci_low" :high="c.ci_high" bar data-testid="verdict-interval" />
            </div>
            <div class="vr-verdict">
              <span v-if="v.kind === 'inconsistent'" class="warn vr-inconsistent" data-testid="verdict-kind" :data-kind="v.kind">{{ v.word }}: {{ v.detail }}</span>
              <template v-else>
                <span class="verdict" :class="{ 'verdict-pill': v.kind !== 'insufficient' }" :data-kind="v.kind" data-testid="verdict-kind">{{ v.word }}</span>
                <span class="muted small mono">{{ v.detail }}</span>
              </template>
            </div>
            <div class="vr-meta">
              <span class="row">
                <span class="badge" :class="c.reliability === 'complete' ? 'badge-good' : 'badge-warn'" data-testid="verdict-reliability">reliability: {{ c.reliability }}</span>
                <span class="badge" :class="policyClass(c.judge_policy_applied)" data-testid="verdict-judge">judge: {{ c.judge_policy_applied }}</span>
              </span>
              <span class="muted small mono">stats {{ c.stats_version }}, {{ when(c.computed_at) }}</span>
              <RouterLink :to="compareLink(c)" class="vr-link" data-testid="verdict-compare-link">Open Compare</RouterLink>
            </div>
          </li>
        </ol>
      </section>

      <!-- row 3: pass rate per config, and cost against pass rate -->
      <section class="split">
        <div class="panel">
          <div class="section-title">
            <h2>Pass rate per config</h2>
            <span class="small muted">macro: mean over tasks of each task's rate</span>
          </div>
          <p v-if="rated.length === 0" class="muted small">No config has a graded trial yet.</p>
          <svg
            v-else
            class="chart"
            data-testid="chart-pass-rate"
            role="img"
            :viewBox="`0 0 ${BARS_W} ${barsHeight}`"
            :aria-label="`Pass rate per config: ${rated.map((c) => `${c.name} ${num(c.pass_rate)}`).join(', ')}`"
          >
            <title>Pass rate per config, from 0 to 1, over all done trials of each config</title>
            <g v-for="(c, i) in rated" :key="c.config_id" :data-testid="`bar-${c.config_id}`">
              <text x="8" :y="i * BAR_ROW + 23" class="lbl">{{ shortName(c.name) }}<title>{{ c.name }}</title></text>
              <rect :x="BAR_X" :y="i * BAR_ROW + 8" :width="BAR_LEN" height="20" rx="3" class="bar-track" />
              <rect :x="BAR_X" :y="i * BAR_ROW + 8" :width="Math.max(0, (c.pass_rate as number) * BAR_LEN)" height="20" rx="3" :class="c.config_id === best?.config_id ? 'bar-a' : 'bar-b'" />
              <text :x="BAR_X + BAR_LEN + 10" :y="i * BAR_ROW + 23" class="lbl mono-lbl">{{ num(c.pass_rate) }}</text>
            </g>
          </svg>
          <p class="muted small caption">
            Over every done trial of the config, in every experiment; a Compare page shows 1 experiment under its judge policy, so its rates can
            differ.<template v-if="unrated > 0"> {{ unrated }} config(s) with no graded trial are not drawn.</template>
          </p>
        </div>

        <div class="panel">
          <div class="section-title">
            <h2>Cost against pass rate</h2>
            <span class="small muted">1 point per config; up and left is better</span>
          </div>
          <p v-if="points.length === 0" class="muted small">No config has both a cost and a graded trial yet.</p>
          <svg
            v-else
            class="chart"
            data-testid="chart-scatter"
            role="img"
            :viewBox="`0 0 ${SC_W} ${SC_H}`"
            :aria-label="`Mean cost per trial against pass rate: ${points.map((p) => `${p.c.name} ${num(p.c.mean_cost_usd, 6)} USD, ${num(p.c.pass_rate)}`).join('; ')}`"
          >
            <title>Mean cost per trial in USD (horizontal) against pass rate (vertical), 1 labelled point per config</title>
            <g v-for="t in [0, 0.5, 1]" :key="`y${t}`">
              <line :x1="SC.left" :y1="sy(t)" :x2="SC_W - SC.right" :y2="sy(t)" class="grid-line" />
              <text :x="SC.left - 8" :y="sy(t) + 4" text-anchor="end" class="lbl small-lbl">{{ t }}</text>
            </g>
            <g v-for="(t, i) in costTicks" :key="`x${i}`">
              <line :x1="sx(t)" :y1="SC_H - SC.bottom" :x2="sx(t)" :y2="SC_H - SC.bottom + 5" class="axis-line" />
              <text :x="sx(t)" :y="SC_H - SC.bottom + 18" :text-anchor="i === 0 ? 'start' : i === 2 ? 'end' : 'middle'" class="lbl small-lbl">{{ num(t, costDigits) }}</text>
            </g>
            <line :x1="SC.left" :y1="SC_H - SC.bottom" :x2="SC_W - SC.right" :y2="SC_H - SC.bottom" class="axis-line" />
            <line :x1="SC.left" :y1="SC.top" :x2="SC.left" :y2="SC_H - SC.bottom" class="axis-line" />
            <text :x="(SC.left + SC_W - SC.right) / 2" :y="SC_H - 6" text-anchor="middle" class="lbl small-lbl">mean cost per trial (USD)</text>
            <text :x="12" :y="(SC.top + SC_H - SC.bottom) / 2" text-anchor="middle" class="lbl small-lbl" :transform="`rotate(-90 12 ${(SC.top + SC_H - SC.bottom) / 2})`">pass rate</text>
            <g v-for="p in points" :key="p.c.config_id" :data-testid="`point-${p.c.config_id}`">
              <circle :cx="p.x" :cy="p.y" r="5" :class="p.c.config_id === best?.config_id ? 'dot' : 'dot-muted'" />
              <text :x="p.lx" :y="p.y + 4" :text-anchor="p.anchor" class="lbl">{{ shortName(p.c.name) }}<title>{{ p.c.name }}: {{ num(p.c.mean_cost_usd, 6) }} USD, pass rate {{ num(p.c.pass_rate) }}</title></text>
            </g>
          </svg>
          <p class="muted small caption">Cost is the macro mean of trial cost_usd over done trials, in USD. The best config by pass rate is drawn in the accent.</p>
        </div>
      </section>

      <!-- row 4: failure categories and recent experiments -->
      <section class="split split-wide-right">
        <div class="panel">
          <div class="section-title">
            <h2>Why trials failed</h2>
            <span class="small muted" data-testid="failure-total">{{ failureTotal }} failed trials</span>
          </div>
          <p v-if="failureRows.length === 0" class="muted small">No failed trial yet.</p>
          <ul v-else class="fail-list" data-testid="failures">
            <li v-for="r in failureRows" :key="r.key" :title="r.rule" :data-testid="`failure-${r.key}`">
              <span class="fail-name mono">{{ r.key }}</span>
              <span class="fail-track" aria-hidden="true"><span class="fail-bar" :class="{ 'fail-bar-unknown': r.key === 'uncategorized' }" :style="{ width: `${(r.n / failureMax) * 100}%` }" /></span>
              <span class="fail-n num">{{ r.n }}</span>
            </li>
          </ul>
          <p class="muted small caption">
            Done trials that failed, all experiments, the first matching rule wins. Hover a row for its rule.
            <template v-if="zeroCategories > 0">{{ zeroCategories }} categories have 0 and are not listed.</template>
          </p>
        </div>

        <div>
          <div class="section-title">
            <h2>Recent experiments</h2>
            <RouterLink to="/experiments" class="small">All experiments</RouterLink>
          </div>
          <DataTable data-testid="recent-table">
            <thead>
              <tr><th>Name</th><th>Status</th><th>Progress</th><th class="num">Trials per cell</th><th>Created</th></tr>
            </thead>
            <tbody>
              <tr v-for="e in summary.recent_experiments" :key="e.id" :data-experiment="e.id" :data-href="`/experiments/${e.id}`">
                <td class="wrap"><RouterLink :to="`/experiments/${e.id}`">{{ e.name }}</RouterLink></td>
                <td><StatusChip :status="e.status" /></td>
                <td>
                  <div class="progress-cell">
                    <span class="mono small" data-testid="progress-fraction">{{ finished(e) }} / {{ e.progress.total }}</span>
                    <progress :value="finished(e)" :max="e.progress.total || 1" :aria-label="`progress of ${e.name}`" />
                  </div>
                </td>
                <td class="num">{{ e.n_trials }}</td>
                <td class="mono small muted">{{ when(e.created_at) }}</td>
              </tr>
            </tbody>
          </DataTable>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.refresh { gap: var(--space-3); }
.empty-cta { display: block; margin-top: var(--space-3); }

/* row 1: 1 surface split into 6 cells by hairlines, not 6 floating cards */
.tiles { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--surface-1); box-shadow: var(--shadow-card); overflow: hidden; }
.tile { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: var(--space-4) var(--space-5); border-left: 1px solid var(--border); }
.tile:first-child { border-left: 0; }
.tile-sub { font-size: var(--fs-12); color: var(--text-muted); overflow-wrap: anywhere; }
.tile-best .tile-sub { color: var(--accent-text); font-weight: var(--fw-strong); }
.is-fail { color: var(--fail-text); }

/* row 2: verdicts as rows of 1 panel */
.verdicts { list-style: none; margin: 0; }
.verdict-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.1fr); gap: var(--space-5); align-items: center; padding: var(--space-4) var(--space-5); border-top: 1px solid var(--border); }
.verdict-row:first-child { border-top: 0; }
.vr-what { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.vr-exp { font-weight: var(--fw-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vr-pair { font-size: var(--fs-13); }
.vr-delta { display: flex; flex-direction: column; gap: var(--space-1); }
.vr-verdict { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-1); }
.vr-verdict .verdict-pill { font-size: var(--fs-20); padding: 4px 14px; white-space: nowrap; }
.vr-inconsistent { font-size: var(--fs-13); font-weight: var(--fw-strong); }
.vr-meta { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-1); }
.vr-link { font-size: var(--fs-13); font-weight: var(--fw-strong); }

/* rows 3 and 4 */
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-4); align-items: stretch; }
.split-wide-right { grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr); align-items: start; }
.caption { margin-top: var(--space-3); max-width: 75ch; }

.chart { display: block; width: 100%; max-width: 640px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-control); }
.lbl { font-family: var(--font-ui); font-size: 12px; fill: var(--text); }
.mono-lbl { font-family: var(--font-mono); }
.small-lbl { font-size: 10px; fill: var(--text-muted); }
.axis-line { stroke: var(--border-strong); stroke-width: 1; }
.grid-line { stroke: var(--border); stroke-width: 1; stroke-dasharray: 2 4; }
.bar-track { fill: var(--surface-1); }
.bar-a { fill: var(--chart-a); }
.bar-b { fill: var(--chart-b); }
.dot { fill: var(--accent); }
.dot-muted { fill: var(--chart-b); }

.fail-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.fail-list li { display: grid; grid-template-columns: 172px minmax(0, 1fr) 40px; gap: var(--space-3); align-items: center; font-size: var(--fs-12); }
.fail-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fail-track { height: 10px; border-radius: var(--radius-pill); background: var(--surface-2); overflow: hidden; }
.fail-bar { display: block; height: 100%; border-radius: var(--radius-pill); background: var(--fail); opacity: 0.75; }
.fail-bar-unknown { background: var(--text-muted); }
.fail-n { text-align: right; font-family: var(--font-mono); }

.progress-cell { display: flex; align-items: center; gap: var(--space-2); }
.progress-cell progress { width: 96px; }

@media (max-width: 1240px) {
  .tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .tile:nth-child(4) { border-left: 0; }
  .tile:nth-child(n + 4) { border-top: 1px solid var(--border); }
  .verdict-row { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr); }
  .vr-meta { grid-column: 1 / -1; flex-direction: row; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
  .split, .split-wide-right { grid-template-columns: minmax(0, 1fr); }
}
</style>
