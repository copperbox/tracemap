import { describe, expect, it } from 'vitest';
import { fadeEnvelope, packetSamples } from './packetAnim';

describe('fadeEnvelope', () => {
  it('is full in the middle and zero at the very ends', () => {
    expect(fadeEnvelope(0.5)).toBe(1);
    expect(fadeEnvelope(0)).toBe(0);
    expect(fadeEnvelope(1)).toBeCloseTo(0);
  });

  it('ramps linearly within the fade band', () => {
    expect(fadeEnvelope(0.04, 0.08)).toBeCloseTo(0.5);
    expect(fadeEnvelope(0.96, 0.08)).toBeCloseTo(0.5);
  });
});

describe('packetSamples', () => {
  it('returns nothing for a dead edge', () => {
    expect(packetSamples(0, 3000, 0, 0)).toEqual([]);
    expect(packetSamples(3, 0, 0, 0)).toEqual([]);
  });

  it('returns one sample per packet', () => {
    expect(packetSamples(1, 3000, 0, 0)).toHaveLength(1);
    expect(packetSamples(12, 3000, 1234, 0.3)).toHaveLength(12);
  });

  it('spaces packets evenly along the edge', () => {
    const ss = packetSamples(4, 3000, 0, 0).map((p) => p.s).sort((a, b) => a - b);
    expect(ss).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('keeps every position within [0, 1)', () => {
    for (const p of packetSamples(8, 2500, 987654, 0.42)) {
      expect(p.s).toBeGreaterThanOrEqual(0);
      expect(p.s).toBeLessThan(1);
      expect(p.opacity).toBeGreaterThanOrEqual(0);
      expect(p.opacity).toBeLessThanOrEqual(1);
    }
  });

  it('advances with time (packets move along the edge)', () => {
    const t0 = packetSamples(1, 3000, 0, 0)[0].s;
    const t1 = packetSamples(1, 3000, 300, 0)[0].s; // 1/10 of the cycle later
    expect(t1).toBeCloseTo(t0 + 0.1);
  });

  it('wraps cleanly after a full cycle', () => {
    const a = packetSamples(3, 3000, 0, 0).map((p) => p.s);
    const b = packetSamples(3, 3000, 3000, 0).map((p) => p.s); // exactly one cycle later
    a.forEach((s, i) => expect(b[i]).toBeCloseTo(s));
  });

  it('desyncs edges by their seed', () => {
    const a = packetSamples(1, 3000, 0, 0)[0].s;
    const b = packetSamples(1, 3000, 0, 0.5)[0].s;
    expect(a).not.toBeCloseTo(b);
  });

  it('is deterministic for the same inputs', () => {
    expect(packetSamples(5, 2200, 4242, 0.7)).toEqual(packetSamples(5, 2200, 4242, 0.7));
  });
});
