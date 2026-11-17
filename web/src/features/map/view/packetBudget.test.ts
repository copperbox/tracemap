import { describe, expect, it } from 'vitest';
import { MAX_PACKETS_PER_FRAME, capPacketCounts, packetBudget } from './packetBudget';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('capPacketCounts', () => {
  it('leaves counts alone under the cap', () => {
    expect(capPacketCounts([3, 0, 5], 10)).toEqual([3, 0, 5]);
  });

  it('scales down to the cap, keeping at least one per live edge', () => {
    const out = capPacketCounts([18, 1, 9, 0, 4], 12);
    expect(sum(out)).toBeLessThanOrEqual(12);
    expect(out[3]).toBe(0);
    for (const i of [0, 1, 2, 4]) expect(out[i]).toBeGreaterThanOrEqual(1);
    // busier edges keep more
    expect(out[0]).toBeGreaterThanOrEqual(out[2]);
    expect(out[2]).toBeGreaterThanOrEqual(out[4]);
  });

  it('keeps one packet on the busiest edges when edges outnumber the cap', () => {
    expect(capPacketCounts([1, 5, 2, 5, 3], 3)).toEqual([0, 1, 0, 1, 1]);
  });

  it('breaks ties at the threshold by input order', () => {
    expect(capPacketCounts([2, 2, 2, 2], 2)).toEqual([1, 1, 0, 0]);
  });

  it('never exceeds the cap on a large fleet', () => {
    const want = Array.from({ length: 9000 }, (_, i) => 1 + (i % 18));
    const out = capPacketCounts(want, 1500);
    expect(sum(out)).toBe(1500);
    expect(Math.max(...out)).toBe(1);
  });

  it('returns nothing for a zero cap', () => {
    expect(sum(capPacketCounts([4, 4], 0))).toBe(0);
  });
});

describe('packetBudget', () => {
  it('is the full cap at card zoom', () => {
    expect(packetBudget(0.8)).toBe(MAX_PACKETS_PER_FRAME);
  });

  it('shrinks when zoomed out, down to a quarter', () => {
    expect(packetBudget(0.25)).toBe(MAX_PACKETS_PER_FRAME / 2);
    expect(packetBudget(0.01)).toBe(MAX_PACKETS_PER_FRAME / 4);
  });
});
