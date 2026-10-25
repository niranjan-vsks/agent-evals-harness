<script setup lang="ts">
// A thin table wrapper (cards/P7.md section 6): a scroll box with a sticky header, and whole-row links. The caller writes
// <thead> and <tbody> as before; an optional #caption slot sits inside the box, directly above the table. Attributes
// (class, data-*) land on the <table>, so selectors such as table.trials still hold.
// A row leads somewhere when it carries data-href: a click anywhere on it navigates, except on a link, button, input or
// select inside it, which keep their own behaviour. The row's own RouterLinks stay the keyboard path.
import { useRouter } from 'vue-router';

defineOptions({ inheritAttrs: false });
withDefaults(defineProps<{ maxHeight?: string }>(), { maxHeight: undefined });

const router = useRouter();

function onClick(ev: MouseEvent): void {
  const target = ev.target as HTMLElement | null;
  if (!target || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  if (target.closest('a, button, input, select, textarea, label, summary')) return;
  const row = target.closest('tr[data-href]');
  const href = row?.getAttribute('data-href');
  if (href && router) void router.push(href);
}
</script>

<template>
  <div class="dt-wrap" :class="{ 'dt-bounded': maxHeight }" :style="maxHeight ? { maxHeight } : undefined">
    <slot name="caption" />
    <table v-bind="$attrs" class="dt" @click="onClick">
      <slot />
    </table>
  </div>
</template>

<style scoped>
.dt-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--surface-1); box-shadow: var(--shadow-card); }
.dt-bounded { overflow-y: auto; }
.dt :deep(thead th) { position: sticky; top: 0; z-index: 1; border-radius: 0; }
.dt :deep(td) { white-space: nowrap; }
@media (max-width: 1240px) {
  .dt :deep(th) { white-space: normal; }
  .dt :deep(th), .dt :deep(td) { padding-left: 10px; padding-right: 10px; }
}
.dt :deep(td.wrap) { white-space: normal; }
.dt-wrap > :slotted(.dt-caption) { margin: 0; padding: 10px var(--space-3); border-bottom: 1px solid var(--border); font-size: var(--fs-12); color: var(--text-muted); }
</style>
