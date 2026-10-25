// The theme switch (cards/P7.md section 4): dark by default, the system preference on first load, the user's choice kept in
// localStorage["evals.theme"]. The theme is one attribute on <html>; every colour is a CSS variable, so nothing else changes.
// index.html runs the same read before the app loads, so the first paint is already in the right theme.
import { readonly, ref } from 'vue';

export type Theme = 'dark' | 'light';

export const THEME_KEY = 'evals.theme';
const SWITCH_MS = 250;

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

const reducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const current = ref<Theme>(stored() ?? systemTheme());
let switchTimer: ReturnType<typeof setTimeout> | null = null;

function apply(theme: Theme, animate: boolean): void {
  const root = document.documentElement;
  if (animate && !reducedMotion()) {
    root.classList.add('theme-switching');
    if (switchTimer !== null) clearTimeout(switchTimer);
    switchTimer = setTimeout(() => {
      root.classList.remove('theme-switching');
      switchTimer = null;
    }, SWITCH_MS);
  }
  root.dataset.theme = theme;
}

apply(current.value, false);

export function useTheme() {
  function setTheme(theme: Theme): void {
    current.value = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode: the choice lasts for this page load only */
    }
    apply(theme, true);
  }
  const toggle = (): void => setTheme(current.value === 'dark' ? 'light' : 'dark');
  return { theme: readonly(current), setTheme, toggle };
}
