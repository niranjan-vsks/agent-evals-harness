import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import Interval from '../Interval.vue';

const text = (props: { value: number | null; low: number | null; high: number | null; digits?: number; unit?: string }) => mount(Interval, { props }).text();

describe('Interval', () => {
  it('renders the value and both bounds as "x [lo, hi]"', () => {
    expect(text({ value: 0.25, low: -0.1, high: 0.6 })).toBe('0.250 [-0.100, 0.600]');
  });

  it('prints a bound that is exactly 0 as 0, not as a blank or a minus', () => {
    expect(text({ value: -0.3333, low: -1, high: 0 })).toBe('-0.333 [-1.000, 0.000]');
    expect(text({ value: 0.2, low: 0, high: 0.5 })).toBe('0.200 [0.000, 0.500]');
  });

  it('shows n/a for a missing bound instead of dropping it', () => {
    expect(text({ value: 0.5, low: null, high: null })).toBe('0.500 [n/a, n/a]');
    expect(text({ value: null, low: 0.1, high: 0.2 })).toBe('n/a [0.100, 0.200]');
  });

  it('honours digits and unit on all three numbers', () => {
    expect(text({ value: 12.345, low: 10, high: 15, digits: 1, unit: ' ms' })).toBe('12.3 ms [10.0 ms, 15.0 ms]');
  });
});
