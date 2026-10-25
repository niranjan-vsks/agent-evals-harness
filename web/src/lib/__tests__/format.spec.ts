import { describe, expect, it } from 'vitest';
import { num, usd, when } from '../format';

describe('format', () => {
  it('num uses fixed decimals and an ASCII minus', () => {
    expect(num(0.5)).toBe('0.500');
    expect(num(-1)).toBe('-1.000');
    expect(num(null)).toBe('n/a');
    expect(num(undefined)).toBe('n/a');
  });

  it('num never prints negative zero', () => {
    expect(num(-0.0000001)).toBe('0.000');
    expect(num(-0)).toBe('0.000');
  });

  it('usd and when handle null', () => {
    expect(usd(0.000597)).toBe('$0.000597');
    expect(usd(null)).toBe('n/a');
    expect(when(null)).toBe('n/a');
    expect(when('2026-10-24T22:18:30.175Z')).toBe('2026-10-24 22:18:30Z');
  });
});
