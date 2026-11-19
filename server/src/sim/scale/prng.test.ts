import { describe, expect, it } from 'vitest';
import { hash32, hashUnit, Prng, subSeed } from './prng.js';

describe('Prng', () => {
  it('repeats the same sequence for the same seed', () => {
    const a = new Prng(42);
    const b = new Prng(42);
    const xs = Array.from({ length: 100 }, () => a.next());
    expect(Array.from({ length: 100 }, () => b.next())).toEqual(xs);
  });

  it('differs between seeds', () => {
    expect(new Prng(1).next()).not.toBe(new Prng(2).next());
  });

  it('stays in range and is roughly uniform', () => {
    const r = new Prng(7);
    let sum = 0;
    for (let i = 0; i < 20000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      sum += x;
    }
    expect(sum / 20000).toBeCloseTo(0.5, 1);
    for (let i = 0; i < 1000; i++) {
      const n = r.int(3, 5);
      expect([3, 4, 5]).toContain(n);
    }
  });

  it('draws weighted indexes in proportion', () => {
    const r = new Prng(3);
    const counts = [0, 0, 0];
    for (let i = 0; i < 30000; i++) counts[r.weighted([1, 2, 0])]++;
    expect(counts[2]).toBe(0);
    expect(counts[1] / counts[0]).toBeGreaterThan(1.8);
    expect(counts[1] / counts[0]).toBeLessThan(2.2);
  });

  it('samples distinct items', () => {
    const s = new Prng(9).sample([1, 2, 3, 4, 5], 3);
    expect(new Set(s).size).toBe(3);
  });

  it('gives a lognormal with the requested median', () => {
    const r = new Prng(11);
    const xs = Array.from({ length: 20001 }, () => r.lognormal(20, 0.5)).sort((a, b) => a - b);
    expect(xs[10000]).toBeGreaterThan(19);
    expect(xs[10000]).toBeLessThan(21);
  });
});

describe('hash helpers', () => {
  it('are stateless and stable', () => {
    expect(hash32(1, 2, 3)).toBe(hash32(1, 2, 3));
    expect(hash32(1, 2, 3)).not.toBe(hash32(1, 2, 4));
    const u = hashUnit(5, 6, 7);
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(1);
  });

  it('derive independent sub-seeds by name', () => {
    expect(subSeed(1, 'fleet')).toBe(subSeed(1, 'fleet'));
    expect(subSeed(1, 'fleet')).not.toBe(subSeed(1, 'health'));
    expect(subSeed(1, 'fleet')).not.toBe(subSeed(2, 'fleet'));
  });
});
