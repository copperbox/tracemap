import { describe, expect, it } from 'vitest';
import { flowDuration } from './flow';

describe('flowDuration', () => {
  it('is faster for higher call rates', () => {
    expect(parseFloat(flowDuration(2000))).toBeLessThan(parseFloat(flowDuration(100)));
  });

  it('clamps to the design range [0.7s, 6s]', () => {
    expect(parseFloat(flowDuration(1_000_000))).toBeGreaterThanOrEqual(0.7);
    expect(parseFloat(flowDuration(0))).toBeLessThanOrEqual(6);
  });

  it('is stable under small rps jitter (no animation restarts on poll)', () => {
    // A 5% metric wobble must not change the animation duration string.
    expect(flowDuration(500)).toBe(flowDuration(515));
    expect(flowDuration(120)).toBe(flowDuration(123));
  });
});
