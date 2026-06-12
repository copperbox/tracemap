import { describe, expect, it } from 'vitest';
import { flowDuration, packetCount, packetCycle, packetDelay, packetDelays } from './flow';

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

describe('packetCount', () => {
  it('is zero when no traffic is being received', () => {
    expect(packetCount(0)).toBe(0);
    expect(packetCount(-1)).toBe(0);
  });

  it('shows at least one packet for any live edge', () => {
    expect(packetCount(0.2)).toBe(1);
    expect(packetCount(1)).toBe(1);
  });

  it('scales with call rate, one packet per decade of rps', () => {
    expect(packetCount(5)).toBe(1);
    expect(packetCount(50)).toBe(2);
    expect(packetCount(500)).toBe(3);
    expect(packetCount(5000)).toBe(4);
  });

  it('caps so busy edges do not strobe', () => {
    expect(packetCount(1_000_000)).toBe(4);
  });

  it('is stable under small rps jitter (no re-render churn on poll)', () => {
    expect(packetCount(50)).toBe(packetCount(51));
  });
});

describe('packetDelays', () => {
  it('returns no delays for an idle edge', () => {
    expect(packetDelays('a=>b', 0)).toEqual([]);
  });

  it('returns one delay per packet', () => {
    expect(packetDelays('a=>b', 5)).toHaveLength(1);
    expect(packetDelays('a=>b', 500)).toHaveLength(3);
  });

  it('starts from the edge-hashed base delay', () => {
    expect(packetDelays('a=>b', 5)[0]).toBe(packetDelay('a=>b'));
  });

  it('spreads packets evenly through the cycle', () => {
    const delays = packetDelays('a=>b', 500).map((d) => parseInt(d, 10));
    const cycleMs = parseFloat(packetCycle(500)) * 1000;
    expect(delays[0] - delays[1]).toBeCloseTo(cycleMs / 3, -1);
    expect(delays[1] - delays[2]).toBeCloseTo(cycleMs / 3, -1);
  });

  it('is deterministic and all delays are non-positive ms offsets', () => {
    expect(packetDelays('a=>b', 500)).toEqual(packetDelays('a=>b', 500));
    for (const d of packetDelays('group:1=>api.stripe.com', 5000)) {
      expect(parseInt(d, 10)).toBeLessThanOrEqual(0);
      expect(d.endsWith('ms')).toBe(true);
    }
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
