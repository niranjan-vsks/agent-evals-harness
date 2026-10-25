<script setup lang="ts">
// Renders "x [lo, hi]" the same way everywhere a number carries an interval (cards/P4.md section 3).
// Both bounds are always shown. A missing bound prints "n/a", never a silent omission.
// P7: `hero` prints the value large (counting up on first render) with the bounds beneath; `bar` adds an inline CI bar
// (a track with a mark at 0, the bar from lo to hi, a dot at the value). Both are drawing only; the text stays "x [lo, hi]".
import { computed } from 'vue';
import { num } from '../lib/format';
import CountUp from './CountUp.vue';

const props = withDefaults(
  defineProps<{
    value: number | null;
    low: number | null;
    high: number | null;
    digits?: number;
    /** Printed after each of the three numbers, e.g. "%" or " ms". */
    unit?: string;
    hero?: boolean;
    bar?: boolean;
    /** The bar's axis; a pass-rate difference lives in [-1, 1]. */
    domain?: [number, number];
  }>(),
  { digits: 3, unit: '', hero: false, bar: false, domain: () => [-1, 1] },
);

const f = (v: number | null): string => (v === null ? 'n/a' : `${num(v, props.digits)}${props.unit}`);
const valueText = computed(() => f(props.value));
const boundsText = computed(() => `[${f(props.low)}, ${f(props.high)}]`);

const BAR_W = 112;
const PAD = 4;
const x = (v: number): number => {
  const [lo, hi] = props.domain;
  const t = hi > lo ? (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo) : 0.5;
  return PAD + t * (BAR_W - 2 * PAD);
};
const zeroX = computed(() => x(0));
const span = computed(() => (props.low === null || props.high === null ? null : { x1: x(props.low), x2: x(props.high) }));
const dotX = computed(() => (props.value === null ? null : x(props.value)));
</script>

<template>
  <span class="interval" :class="{ 'iv-hero': hero, 'iv-with-bar': bar }">
    <span class="iv-value"><CountUp v-if="hero" :value="value" :digits="digits" :unit="unit" /><template v-else>{{ valueText }}</template></span>{{ ' ' }}<span class="iv-bounds">{{ boundsText }}</span>
    <svg v-if="bar" class="iv-bar" :viewBox="`0 0 ${BAR_W} 14`" :width="BAR_W" height="14" aria-hidden="true" focusable="false">
      <line :x1="PAD" y1="7" :x2="BAR_W - PAD" y2="7" class="iv-track" />
      <line :x1="zeroX" y1="2" :x2="zeroX" y2="12" class="iv-zero" />
      <rect v-if="span" :x="span.x1" y="4" :width="Math.max(1.5, span.x2 - span.x1)" height="6" rx="3" class="iv-span" />
      <circle v-if="dotX !== null" :cx="dotX" cy="7" r="3" class="iv-dot" />
    </svg>
  </span>
</template>

<style scoped>
.interval { font-family: var(--font-mono); font-size: var(--fs-12); font-variant-numeric: tabular-nums; white-space: nowrap; }
.iv-with-bar { display: inline-flex; align-items: center; gap: 6px; }
.iv-with-bar .iv-bar { order: -1; margin-right: 4px; }
.iv-hero { display: inline-flex; flex-direction: column; gap: 2px; font-family: var(--font-ui); }
.iv-hero .iv-value { font-size: var(--fs-28); font-weight: var(--fw-strong); letter-spacing: -0.01em; line-height: 1.15; color: var(--text); }
.iv-hero .iv-bounds { font-family: var(--font-mono); font-size: var(--fs-13); color: var(--text-muted); }
.iv-hero.iv-with-bar { flex-direction: column; align-items: flex-start; }
.iv-hero.iv-with-bar .iv-bar { order: 3; margin: 6px 0 0; width: 168px; height: 21px; }
.iv-track { stroke: var(--border-strong); stroke-width: 1; }
.iv-zero { stroke: var(--text-muted); stroke-width: 1; }
.iv-span { fill: var(--accent); opacity: 0.35; }
.iv-dot { fill: var(--accent); }
</style>
