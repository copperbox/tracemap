import { describe, expect, it } from 'vitest';
import { hoverIndex, hoverXPct } from './spark';

describe('hoverIndex', () => {
  it('snaps a fraction to the nearest data index', () => {
    expect(hoverIndex(0, 5)).toBe(0);
    expect(hoverIndex(1, 5)).toBe(4);
    expect(hoverIndex(0.5, 5)).toBe(2);
  });

  it('rounds to the closest point', () => {
    // 0.3 * 9 = 2.7 -> 3
    expect(hoverIndex(0.3, 10)).toBe(3);
  });

  it('maps the same fraction to the same index across charts of equal length', () => {
    const n = 48;
    const frac = 0.42;
    expect(hoverIndex(frac, n)).toBe(hoverIndex(frac, n));
  });
});

describe('hoverXPct', () => {
  it('returns a snapped percentage at the data point', () => {
    expect(hoverXPct(0, 5)).toBe('0.00%');
    expect(hoverXPct(4, 5)).toBe('100.00%');
    expect(hoverXPct(2, 5)).toBe('50.00%');
  });

  it('agrees with hoverIndex so synced charts align', () => {
    const n = 24;
    const frac = 0.73;
    const idx = hoverIndex(frac, n);
    expect(hoverXPct(idx, n)).toBe(`${((idx / (n - 1)) * 100).toFixed(2)}%`);
  });
});
