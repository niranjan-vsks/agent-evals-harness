<script setup lang="ts">
// A shimmer placeholder in the shape of what is loading: table rows (default) or lines of text. The loading sentence the
// views print stays next to it, so the state is said in words and not only drawn.
withDefaults(defineProps<{ rows?: number; variant?: 'table' | 'lines' }>(), { rows: 4, variant: 'table' });
</script>

<template>
  <div class="skel" :class="`skel-${variant}`" aria-hidden="true">
    <div v-for="i in rows" :key="i" class="skel-row">
      <template v-if="variant === 'table'">
        <span class="skeleton" style="width: 22%" />
        <span class="skeleton" style="width: 12%" />
        <span class="skeleton" style="width: 30%" />
        <span class="skeleton" style="width: 14%" />
      </template>
      <span v-else class="skeleton" :style="{ width: `${92 - ((i * 17) % 40)}%` }" />
    </div>
  </div>
</template>

<style scoped>
.skel { display: flex; flex-direction: column; }
.skel-table .skel-row { display: flex; gap: var(--space-5); padding: 12px var(--space-3); border-bottom: 1px solid var(--border); }
.skel-table .skel-row:last-child { border-bottom: 0; }
.skel-lines { gap: 10px; padding: var(--space-2) 0; }
</style>
