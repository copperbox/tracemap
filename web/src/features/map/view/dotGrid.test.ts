import { describe, expect, it } from 'vitest';
import { DOT_MIN_ALPHA, DOT_REF_K, dotAlphaScale } from './dotGrid';

describe('dotAlphaScale', () => {
  it('leaves dots at full strength at the reference zoom', () => {
    expect(dotAlphaScale(DOT_REF_K)).toBe(1);
  });

  it('clamps to full strength when zoomed in past the reference', () => {
    expect(dotAlphaScale(1)).toBe(1);
    expect(dotAlphaScale(2.4)).toBe(1);
  });

  it('dims as ~(k/ref)^2 below the reference to cancel the 1/k^2 brightening', () => {
    // Half the reference zoom -> a quarter of the brightness compensation.
    expect(dotAlphaScale(DOT_REF_K / 2)).toBeCloseTo(0.25);
    // The reachable min zoom (0.12) lands well into the dim range.
    expect(dotAlphaScale(0.12)).toBeCloseTo((0.12 / DOT_REF_K) ** 2);
  });

  it('decreases monotonically as you zoom out', () => {
    const a = dotAlphaScale(0.45);
    const b = dotAlphaScale(0.3);
    const c = dotAlphaScale(0.15);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it('never drops below the floor', () => {
    expect(dotAlphaScale(0.001)).toBe(DOT_MIN_ALPHA);
    expect(dotAlphaScale(0)).toBe(DOT_MIN_ALPHA);
  });
});
