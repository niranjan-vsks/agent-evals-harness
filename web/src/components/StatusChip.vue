<script setup lang="ts">
// A status word in a coloured box, for experiment statuses, trial statuses and the paused flag.
// The colour is a hint only; the word is always printed.
defineProps<{ status: string }>();
</script>

<template>
  <span class="chip" :class="`chip-${status}`">{{ status }}</span>
</template>
