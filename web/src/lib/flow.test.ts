import { describe, expect, it } from 'vitest';
import { PACKET_CAP, packetCount, packetSeed, packetTravelMs } from './flow';

describe('packetCount', () => {
  it('is zero when no traffic is being received', () => {
    expect(packetCount(0)).toBe(0);
    expect(packetCount(-1)).toBe(0);
  });

  it('shows at least one packet for any live edge', () => {
    expect(packetCount(0.2)).toBe(1);
    expect(packetCount(1)).toBe(1);
  });

  it('rises monotonically with call rate', () => {
    for (const [lo, hi] of [
      [1, 10],
      [10, 50],
      [50, 500],
      [500, 2000],
    ]) {
      expect(packetCount(hi)).toBeGreaterThan(packetCount(lo));
    }
  });

  it('separates the mid-traffic band (50 vs 500 rps read differently)', () => {
    // The whole point of the high cap: these no longer collapse to 2 vs 3.
    expect(packetCount(500) - packetCount(50)).toBeGreaterThanOrEqual(4);
  });

  it('keeps low traffic sparse', () => {
    expect(packetCount(5)).toBeLessThanOrEqual(4);
  });

  it('caps busy edges at PACKET_CAP', () => {
    expect(packetCount(1_000_000)).toBe(PACKET_CAP);
    expect(packetCount(50)).toBeLessThanOrEqual(PACKET_CAP);
  });

  it('is much higher than the old fixed cap of 4', () => {
    expect(PACKET_CAP).toBeGreaterThan(4);
  });
});

describe('packetTravelMs', () => {
  it('takes longer to cross a longer edge', () => {
    expect(packetTravelMs(800)).toBeGreaterThan(packetTravelMs(200));
  });

  it('clamps to a readable range for extreme lengths', () => {
    expect(packetTravelMs(1)).toBeGreaterThanOrEqual(1400);
    expect(packetTravelMs(0)).toBeGreaterThanOrEqual(1400);
    expect(packetTravelMs(100000)).toBeLessThanOrEqual(6000);
  });
});

describe('packetSeed', () => {
  it('is a deterministic unit phase per edge key', () => {
    expect(packetSeed('a=>b')).toBe(packetSeed('a=>b'));
    const v = packetSeed('group:1=>api.stripe.com');
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it('staggers different edges', () => {
    const seeds = new Set(['a=>b', 'b=>c', 'c=>d', 'group:1=>group:2'].map(packetSeed));
    expect(seeds.size).toBeGreaterThan(1);
  });
});
