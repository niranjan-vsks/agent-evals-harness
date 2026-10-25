<script setup lang="ts">
// The theme toggle in the header: 2 labelled options, the current one pressed. The choice is kept by useTheme().
import { useTheme, type Theme } from '../lib/theme';

const { theme, setTheme } = useTheme();
const OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];
</script>

<template>
  <div class="theme-toggle" role="group" aria-label="Theme">
    <button
      v-for="o in OPTIONS"
      :key="o.value"
      type="button"
      class="tt-option"
      :class="{ on: theme === o.value }"
      :aria-pressed="theme === o.value"
      :data-theme-option="o.value"
      @click="setTheme(o.value)"
    >
      <svg v-if="o.value === 'dark'" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M13.5 9.6A5.5 5.5 0 0 1 6.4 2.5a5.5 5.5 0 1 0 7.1 7.1Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
      </svg>
      <svg v-else viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.4" />
        <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
      {{ o.label }}
    </button>
  </div>
</template>

<style scoped>
.theme-toggle { display: inline-flex; padding: 2px; gap: 2px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-control); }
.tt-option { height: 26px; padding: 0 10px; gap: 6px; background: transparent; border: 0; color: var(--text-muted); font-size: var(--fs-12); border-radius: 4px; }
.tt-option:hover:not(:disabled) { color: var(--text); border: 0; }
.tt-option.on { background: var(--surface-1); color: var(--text); box-shadow: 0 0 0 1px var(--border-strong); }
</style>
