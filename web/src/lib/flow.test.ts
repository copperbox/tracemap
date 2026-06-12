import { describe, expect, it } from 'vitest';
import { flowDuration, packetCycle, packetDelay } from './flow';

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

describe('packetCycle', () => {
  it('emits packets more often on busier edges', () => {
    expect(parseFloat(packetCycle(100))).toBeLessThan(parseFloat(packetCycle(2)));
  });

  it('clamps to the design range [4s, 14s]', () => {
    expect(parseFloat(packetCycle(1_000_000))).toBeGreaterThanOrEqual(4);
    expect(parseFloat(packetCycle(0))).toBeLessThanOrEqual(14);
  });

  it('is stable under small rps jitter (no animation restarts on poll)', () => {
    expect(packetCycle(50)).toBe(packetCycle(51));
  });
});

describe('packetDelay', () => {
  it('is deterministic per edge key', () => {
    expect(packetDelay('a=>b')).toBe(packetDelay('a=>b'));
  });

  it('staggers different edges', () => {
    const delays = new Set(['a=>b', 'b=>c', 'c=>d', 'group:1=>group:2'].map(packetDelay));
    expect(delays.size).toBeGreaterThan(1);
  });

  it('is a non-positive ms offset (starts mid-cycle, never pauses first)', () => {
    for (const k of ['a=>b', 'x', 'group:3=>api.stripe.com']) {
      const v = parseInt(packetDelay(k), 10);
      expect(v).toBeLessThanOrEqual(0);
      expect(packetDelay(k).endsWith('ms')).toBe(true);
    }
  });
});
