import { describe, expect, it } from 'vitest';
import { CompactIdSet, RotatingIdSet, hexWords } from './idSet.js';

describe('hexWords', () => {
  it('splits a 16-hex id into two words', () => {
    expect(hexWords('00000001ffffffff')).toEqual([1, 0xffffffff]);
  });

  it('folds a 32-hex id', () => {
    expect(hexWords('00000001000000020000000300000004')).toEqual([1 ^ 3, 2 ^ 4]);
  });

  it('maps garbage to zero', () => {
    expect(hexWords('zz')).toEqual([0, 0]);
  });
});

describe('CompactIdSet', () => {
  it('adds, finds and dedupes', () => {
    const s = new CompactIdSet(100);
    expect(s.add(1, 2)).toBe(true);
    expect(s.add(1, 2)).toBe(false);
    expect(s.has(1, 2)).toBe(true);
    expect(s.has(2, 1)).toBe(false);
    expect(s.add(0, 0)).toBe(true);
    expect(s.has(0, 0)).toBe(true);
    expect(s.size).toBe(2);
  });

  it('holds many ids without false negatives', () => {
    const s = new CompactIdSet(1 << 15);
    for (let i = 0; i < 16_000; i++) s.add(i * 7919, i);
    for (let i = 0; i < 16_000; i++) expect(s.has(i * 7919, i)).toBe(true);
    expect(s.has(5, 999_999)).toBe(false);
  });
});

describe('RotatingIdSet', () => {
  it('remembers ids across one rotation and forgets after two', () => {
    const s = new RotatingIdSet(64, 1000, 0);
    s.add(1, 1, 0);
    s.add(2, 2, 1500); // rotates: (1,1) moves to the previous generation
    expect(s.has(1, 1)).toBe(true);
    s.add(3, 3, 3000); // rotates again: (1,1) is gone
    expect(s.has(1, 1)).toBe(false);
    expect(s.has(2, 2)).toBe(true);
  });

  it('rotates early when a generation is half full, and counts it', () => {
    const s = new RotatingIdSet(16, 60_000, 0);
    for (let i = 1; i <= 20; i++) s.add(i, i, 1);
    expect(s.earlyRotations).toBeGreaterThan(0);
    expect(s.has(20, 20)).toBe(true);
    expect(s.size).toBeLessThanOrEqual(32);
  });
});
