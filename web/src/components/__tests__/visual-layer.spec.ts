// P7 visual layer: the theme switch, the row links of DataTable, the count-up's final text and the inline CI bar.
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { THEME_KEY, useTheme } from '../../lib/theme';
import CountUp from '../CountUp.vue';
import DataTable from '../DataTable.vue';
import Interval from '../Interval.vue';
import ThemeToggle from '../ThemeToggle.vue';

afterEach(() => {
  localStorage.clear();
});

describe('useTheme and ThemeToggle', () => {
  it('starts dark with no stored choice and no matchMedia', () => {
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('sets data-theme on <html>, stores the choice and marks the pressed option', async () => {
    const w = mount(ThemeToggle);
    await w.get('[data-theme-option="light"]').trigger('click');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(w.get('[data-theme-option="light"]').attributes('aria-pressed')).toBe('true');
    expect(w.get('[data-theme-option="dark"]').attributes('aria-pressed')).toBe('false');
    useTheme().toggle();
    await flushPromises();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
  });

  it('labels both options in words', () => {
    const w = mount(ThemeToggle);
    expect(w.findAll('button').map((b) => b.text())).toEqual(['Dark', 'Light']);
  });
});

describe('DataTable', () => {
  const routerAt = async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { template: '<div />' } }] });
    await router.push('/start');
    return router;
  };
  const table = (router: Awaited<ReturnType<typeof routerAt>>) =>
    mount(DataTable, {
      attrs: { class: 'trials', 'data-testid': 't' },
      slots: { default: '<tbody><tr data-href="/trials/T1"><td class="cell">x</td><td><a href="/elsewhere" class="own">own</a></td></tr><tr><td class="plain">y</td></tr></tbody>' },
      global: { plugins: [router] },
    });

  it('puts class and data attributes on the <table>', async () => {
    const w = table(await routerAt());
    expect(w.find('table.trials[data-testid="t"]').exists()).toBe(true);
  });

  it('navigates when a cell of a linked row is clicked, and leaves links, unlinked rows alone', async () => {
    const router = await routerAt();
    const w = table(router);
    await w.get('td.plain').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/start');
    await w.get('a.own').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/start');
    await w.get('td.cell').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/trials/T1');
  });
});

describe('CountUp and the Interval bar', () => {
  it('prints the final formatted value at once when motion is not available', () => {
    expect(mount(CountUp, { props: { value: -0.3142 } }).text()).toBe('-0.314');
    expect(mount(CountUp, { props: { value: null } }).text()).toBe('n/a');
  });

  it('keeps the text "x [lo, hi]" in hero and bar modes, and draws the bar from lo to hi with the 0 mark', () => {
    const w = mount(Interval, { props: { value: -0.314, low: -0.549, high: -0.098, hero: true, bar: true } });
    expect(w.text()).toBe('-0.314 [-0.549, -0.098]');
    const rect = w.get('svg rect');
    expect(Number(rect.attributes('width'))).toBeGreaterThan(0);
    expect(w.findAll('svg line').length).toBe(2);
    expect(w.find('svg circle').exists()).toBe(true);
  });

  it('draws no bar span when a bound is missing', () => {
    const w = mount(Interval, { props: { value: 0.5, low: null, high: null, bar: true } });
    expect(w.text()).toBe('0.500 [n/a, n/a]');
    expect(w.find('svg rect').exists()).toBe(false);
  });
});
