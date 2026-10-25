<script setup lang="ts">
// A status word in a coloured pill, for experiment statuses, trial statuses and the paused flag.
// The colour is a hint only (semantic tokens, base.css); the word is always printed.
defineProps<{ status: string }>();
</script>

<template>
  <span class="chip" :class="`chip-${status}`">{{ status }}</span>
</template>
