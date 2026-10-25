<script setup lang="ts">
// An empty state that says what to do next (cards/P7.md section 3). The title is the fact, the slot is the next step.
defineProps<{ title: string }>();
</script>

<template>
  <div class="empty" role="status">
    <svg class="empty-mark" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4" />
      <path d="M3.5 9.5h17" stroke="currentColor" stroke-width="1.4" />
    </svg>
    <div>
      <p class="empty-title">{{ title }}</p>
      <p v-if="$slots.default" class="empty-next"><slot /></p>
    </div>
  </div>
</template>

<style scoped>
.empty { display: flex; align-items: flex-start; gap: var(--space-3); padding: var(--space-5); border: 1px dashed var(--border-strong); border-radius: var(--radius-card); color: var(--text-muted); }
.empty-mark { flex: none; margin-top: 1px; color: var(--accent); }
.empty-title { color: var(--text); font-weight: var(--fw-strong); }
.empty-next { margin-top: 2px; font-size: var(--fs-13); }
</style>
