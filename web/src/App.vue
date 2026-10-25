<script setup lang="ts">
import { ref } from 'vue';
import { useAppStore } from './stores/app';

const store = useAppStore();
const draftBase = ref(store.apiBase);

function applyBase() {
  store.applyBase(draftBase.value);
  draftBase.value = store.apiBase;
}
</script>

<template>
  <header class="topbar">
    <span class="brand">agent-evals-harness</span>
    <nav>
      <RouterLink to="/configs">Configs</RouterLink>
      <RouterLink to="/experiments">Experiments</RouterLink>
    </nav>
    <span class="spacer" />
    <label class="small muted">
      API base
      <input v-model="draftBase" type="text" aria-label="API base URL" @change="applyBase" />
    </label>
  </header>
  <main>
    <RouterView :key="$route.fullPath" />
  </main>
</template>
