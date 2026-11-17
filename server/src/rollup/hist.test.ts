import { describe, expect, it } from 'vitest';
import {
  HIST_BUCKETS,
  addValue,
  bucketLowerMs,
  bucketOf,
  decode,
  decodeInto,
  encode,
  histTotal,
  mergeInto,
  newHist,
  newWideHist,
  quantile,
} from './hist.js';

describe('bucketOf', () => {
  it('maps a value into the bucket whose range contains it', () => {
    for (const ms of [0.011, 0.5, 1, 12.3, 250, 9000]) {
      const i = bucketOf(ms);
      expect(bucketLowerMs(i)).toBeLessThanOrEqual(ms * (1 + 1e-12));
      expect(bucketLowerMs(i + 1)).toBeGreaterThan(ms);
    }
  });

  it('clamps below and above the range', () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(-5)).toBe(0);
    expect(bucketOf(Number.NaN)).toBe(0);
    expect(bucketOf(0.001)).toBe(0);
    expect(bucketOf(1e9)).toBe(HIST_BUCKETS - 1);
    expect(bucketOf(Number.POSITIVE_INFINITY)).toBe(HIST_BUCKETS - 1);
  });
});

describe('quantile', () => {
  it('stays within about 5% of the true value', () => {
    const h = newHist();
    const values: number[] = [];
    for (let i = 1; i <= 10_000; i++) {
      const v = i / 10; // 0.1 .. 1000 ms, uniform
      values.push(v);
      addValue(h, v);
    }
    for (const q of [0.5, 0.95, 0.99]) {
      const truth = values[Math.ceil(q * values.length) - 1];
      expect(Math.abs(quantile(h, q) - truth) / truth).toBeLessThan(0.06);
    }
  });

  it('is NaN for an empty histogram', () => {
    expect(quantile(newHist(), 0.5)).toBeNaN();
  });
});

describe('sparse codec', () => {
  it('round-trips and adds into the target', () => {
    const h = newHist();
    for (const v of [0.01, 1, 1, 2, 50, 50, 50, 1e6]) addValue(h, v);
    const buf = encode(h);
    expect(buf.length).toBeLessThan(20);
    const back = decode(buf);
    expect([...back]).toEqual([...h]);
    decodeInto(buf, back);
    expect(histTotal(back)).toBe(2 * histTotal(h));
  });

  it('encodes an empty histogram as zero bytes', () => {
    expect(encode(newHist()).length).toBe(0);
    expect(histTotal(decode(Buffer.alloc(0)))).toBe(0);
  });

  it('carries counts up to 2^53', () => {
    const h = newWideHist();
    h[0] = 2 ** 53 - 1;
    h[175] = 2 ** 40 + 7;
    h[100] = 3_000_000_000;
    expect([...decode(encode(h))]).toEqual([...h]);
  });

  it('rejects malformed input', () => {
    expect(() => decode(Buffer.from([0x80]))).toThrow();
    expect(() => decode(Buffer.from([200, 1, 1]))).toThrow(); // index 200 out of range
    const bad = newWideHist();
    bad[3] = 1.5;
    expect(() => encode(bad)).toThrow();
  });
});

describe('mergeInto', () => {
  it('adds bucket by bucket', () => {
    const a = newWideHist();
    const b = newHist();
    addValue(a, 5);
    addValue(b, 5);
    addValue(b, 500);
    mergeInto(a, b);
    expect(histTotal(a)).toBe(3);
    expect(a[bucketOf(5)]).toBe(2);
  });
});
