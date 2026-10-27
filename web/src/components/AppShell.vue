<script setup lang="ts">
// The app shell (cards/P7.md section 3): a 56 px top bar with the wordmark, the 3 nav links (Overview first, P8), the API
// base and the theme toggle, then the page content centred at most 1,440 px wide. The API base field is the one P4 had in App.vue.
import { ref } from 'vue';
import { useAppStore } from '../stores/app';
import ThemeToggle from './ThemeToggle.vue';

const store = useAppStore();
const draftBase = ref(store.apiBase);

function applyBase() {
  store.applyBase(draftBase.value);
  draftBase.value = store.apiBase;
}
</script>

<template>
  <header class="topbar">
    <div class="topbar-inner">
      <RouterLink to="/" class="wordmark">Agent Evals</RouterLink>
      <nav class="nav" aria-label="Main">
        <RouterLink to="/" class="nav-link">Overview</RouterLink>
        <RouterLink to="/configs" class="nav-link">Configs</RouterLink>
        <RouterLink to="/experiments" class="nav-link">Experiments</RouterLink>
      </nav>
      <span class="spacer" />
      <label class="api-base">
        <span>API base</span>
        <input v-model="draftBase" type="text" class="mono" aria-label="API base URL" spellcheck="false" @change="applyBase" />
      </label>
      <ThemeToggle />
    </div>
  </header>
  <main class="content">
    <slot />
  </main>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  height: var(--header-h);
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
}
/* The header underline: the only other place the accent gradient appears. */
.topbar::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 1px; background: var(--accent-gradient); opacity: 0.85; }
.topbar-inner { display: flex; align-items: center; gap: var(--space-5); height: 100%; max-width: var(--content-max); margin: 0 auto; padding: 0 var(--space-6); }
.wordmark { color: var(--accent-text); font-size: var(--fs-16); font-weight: var(--fw-strong); letter-spacing: -0.01em; white-space: nowrap; }
.wordmark:hover { color: var(--accent-hover); text-decoration: none; }
.nav { display: flex; align-items: stretch; gap: var(--space-1); height: 100%; }
.nav-link { position: relative; display: inline-flex; align-items: center; padding: 0 var(--space-3); color: var(--text-muted); font-size: var(--fs-13); font-weight: var(--fw-strong); }
.nav-link:hover { color: var(--text); text-decoration: none; }
.nav-link::after { content: ''; position: absolute; left: var(--space-3); right: var(--space-3); bottom: -1px; height: 2px; border-radius: 2px; background: var(--accent); transform: scaleX(0); transition: transform var(--dur-fast) var(--ease-out); z-index: 1; }
.nav-link.router-link-active { color: var(--text); }
.nav-link.router-link-active::after { transform: scaleX(1); }
.spacer { flex: 1; }
.api-base { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--fs-12); color: var(--text-muted); white-space: nowrap; }
.api-base input { width: 168px; height: 28px; font-size: var(--fs-12); }
.content { max-width: var(--content-max); margin: 0 auto; padding: var(--space-5) var(--space-6) 64px; }

@media (max-width: 1100px) {
  .topbar-inner, .content { padding-left: var(--space-5); padding-right: var(--space-5); }
  .api-base span { display: none; }
}
</style>
