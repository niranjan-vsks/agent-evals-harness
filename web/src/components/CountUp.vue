<script setup lang="ts">
// A number that counts up from 0 to its value over 400 ms the first time it renders (cards/P7.md section 3), then prints
// exactly num(value, digits), the same text as without the animation. Later changes are shown at once. No animation when
// the browser asks for reduced motion or has no matchMedia (jsdom), so tests and screen readers always get the final text.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { num } from '../lib/format';

const props = withDefaults(defineProps<{ value: number | null; digits?: number; unit?: string }>(), { digits: 3, unit: '' });

const DURATION_MS = 400;
const shown = ref<number | null>(props.value);
let frame = 0;

const canAnimate = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  typeof window.requestAnimationFrame === 'function' &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const easeOutQuart = (t: number): number => 1 - (1 - t) ** 4;

onMounted(() => {
  const target = props.value;
  if (target === null || target === 0 || !canAnimate()) return;
  const start = performance.now();
  shown.value = 0;
  const step = (now: number): void => {
    const t = Math.min(1, (now - start) / DURATION_MS);
    shown.value = t < 1 ? target * easeOutQuart(t) : target;
    if (t < 1) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
});

watch(
  () => props.value,
  (v) => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    shown.value = v;
  },
);

onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame);
});

const text = computed(() => (shown.value === null ? 'n/a' : `${num(shown.value, props.digits)}${props.unit}`));
</script>

<template>
  <span class="count-up">{{ text }}</span>
</template>

<style scoped>
.count-up { font-variant-numeric: tabular-nums; }
</style>
