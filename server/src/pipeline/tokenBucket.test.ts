import { describe, expect, it } from 'vitest';
import { TokenBucket } from './tokenBucket.js';

describe('TokenBucket', () => {
  it('refills at the rate up to capacity', () => {
    const b = new TokenBucket(10, 100, 0, 0);
    expect(b.available(1000)).toBe(10);
    expect(b.available(60_000)).toBe(100);
  });

  it('spends only when enough tokens are available', () => {
    const b = new TokenBucket(10, 100, 50, 0);
    expect(b.trySpend(40, 0)).toBe(true);
    expect(b.trySpend(20, 0)).toBe(false);
    expect(b.available(0)).toBe(10);
  });

  it('respects a floor (spend only while above it)', () => {
    const b = new TokenBucket(10, 100, 50, 0);
    expect(b.trySpend(1, 0, 50)).toBe(false);
    expect(b.trySpend(1, 1000, 50)).toBe(true);
  });
});
