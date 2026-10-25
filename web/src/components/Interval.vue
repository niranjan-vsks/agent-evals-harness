<script setup lang="ts">
// Renders "x [lo, hi]" the same way everywhere a number carries an interval (cards/P4.md section 3).
// Both bounds are always shown. A missing bound prints "n/a", never a silent omission.
import { computed } from 'vue';
import { num } from '../lib/format';

const props = withDefaults(
  defineProps<{
    value: number | null;
    low: number | null;
    high: number | null;
    digits?: number;
    /** Printed after each of the three numbers, e.g. "%" or " ms". */
    unit?: string;
  }>(),
  { digits: 3, unit: '' },
);

const text = computed(() => {
  const u = props.unit;
  const f = (v: number | null) => (v === null ? 'n/a' : `${num(v, props.digits)}${u}`);
  return `${f(props.value)} [${f(props.low)}, ${f(props.high)}]`;
});
</script>

<template>
  <span class="interval">{{ text }}</span>
</template>
