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
  it('tracks a smooth distribution closely', () => {
    const h = newHist();
    const values: number[] = [];
    for (let i = 1; i <= 10_000; i++) {
      const v = i / 10; // 0.1 .. 1000 ms, uniform
      values.push(v);
      addValue(h, v);
    }
    for (const q of [0.5, 0.95, 0.99]) {
      const truth = values[Math.ceil(q * values.length) - 1];
      expect(Math.abs(quantile(h, q) - truth) / truth).toBeLessThan(0.03);
    }
  });

  it('always lands inside the bucket holding the true value', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const values = Array.from({ length: 5000 }, () => Math.exp(rnd() * 10) * 0.1).sort((a, b) => a - b);
    const h = newHist();
    for (const v of values) addValue(h, v);
    for (let q = 0.01; q < 1; q += 0.01) {
      const truth = values[Math.ceil(q * values.length) - 1];
      const i = bucketOf(truth);
      const got = quantile(h, q);
      expect(got).toBeGreaterThanOrEqual(bucketLowerMs(i) * (1 - 1e-12));
      expect(got).toBeLessThanOrEqual(bucketLowerMs(i + 1) * (1 + 1e-12));
    }
  });

  it('interpolates by rank inside a bucket instead of snapping to its midpoint', () => {
    const h = newWideHist();
    h[50] = 100;
    const lo = bucketLowerMs(50);
    expect(quantile(h, 0)).toBeCloseTo(lo, 9);
    expect(quantile(h, 0.5)).toBeCloseTo(lo * Math.sqrt(1.1), 9);
    expect(quantile(h, 1)).toBeCloseTo(bucketLowerMs(51), 9);
    // Monotonic in q, with distinct values for p50, p95, p99.
    const p = [0.5, 0.95, 0.99].map((q) => quantile(h, q));
    expect(p[0]).toBeLessThan(p[1]);
    expect(p[1]).toBeLessThan(p[2]);
    // A shift in traffic moves the quantile smoothly, not in bucket steps.
    const g = newWideHist();
    g[50] = 90;
    g[51] = 10;
    const before = quantile(g, 0.95);
    g[51] = 12;
    expect(quantile(g, 0.95)).toBeGreaterThan(before);
    expect(quantile(g, 0.95) / before).toBeLessThan(1.02);
  });

  it('skips empty buckets and handles q outside [0, 1]', () => {
    const h = newWideHist();
    h[10] = 1;
    h[100] = 1;
    expect(quantile(h, 0.5)).toBeCloseTo(bucketLowerMs(11), 9);
    expect(quantile(h, 0.75)).toBeCloseTo(bucketLowerMs(100) * Math.sqrt(1.1), 9);
    expect(quantile(h, -1)).toBeCloseTo(bucketLowerMs(10), 9);
    expect(quantile(h, 2)).toBeCloseTo(bucketLowerMs(101), 9);
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

  it('rejects counts beyond 2^53 - 1 and sums that would lose precision', () => {
    // Bucket 0, count 2^53: varint of 2^53 is seven 0x80 bytes then 0x10.
    const big = Buffer.from([0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10]);
    expect(() => decode(big)).toThrow(/2\^53/);
    const h = newWideHist();
    h[0] = 2 ** 53 - 1;
    const one = newWideHist();
    one[0] = 1;
    const target = decode(encode(h));
    expect(() => decodeInto(encode(one), target)).toThrow(/overflows/);
    expect(target[0]).toBe(2 ** 53 - 1);
    // A per-minute u32 target must not wrap.
    const narrow = newHist();
    narrow[0] = 0xffff_ffff;
    expect(() => decodeInto(encode(one), narrow)).toThrow(/overflows/);
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

  it('throws instead of wrapping or rounding', () => {
    const one = newWideHist();
    one[7] = 1;
    const narrow = newHist();
    narrow[7] = 0xffff_ffff;
    expect(() => mergeInto(narrow, one)).toThrow(/overflows/);
    const wide = newWideHist();
    wide[7] = Number.MAX_SAFE_INTEGER;
    expect(() => mergeInto(wide, one)).toThrow(/overflows/);
  });

  it('rejects negative, fractional, NaN and unsafe source counts', () => {
    for (const bad of [-1, 0.5, 2.25, NaN, Infinity, 2 ** 53]) {
      const src = newWideHist();
      src[3] = bad;
      expect(() => mergeInto(newWideHist(), src), String(bad)).toThrow(/invalid source count/);
      expect(() => mergeInto(newHist(), src), String(bad)).toThrow(/invalid source count/);
    }
  });

  it('rejects a sum a Uint32Array cannot hold, whatever the source type', () => {
    const narrow = newHist();
    narrow[2] = 0xffff_fff0;
    const src = newWideHist();
    src[2] = 0x20;
    expect(() => mergeInto(narrow, src)).toThrow(/overflows/);
    // The bucket was not wrapped.
    expect(narrow[2]).toBe(0xffff_fff0);
    // A source count above u32 into a narrow target fails too.
    const big = newWideHist();
    big[2] = 2 ** 33;
    expect(() => mergeInto(newHist(), big)).toThrow(/overflows/);
  });

  it('rejects a target bucket that already holds an invalid value', () => {
    const wide = newWideHist();
    wide[4] = NaN;
    const one = newWideHist();
    one[4] = 1;
    expect(() => mergeInto(wide, one)).toThrow(/invalid/);
    wide[4] = 0.5;
    expect(() => mergeInto(wide, one)).toThrow(/invalid/);
  });

  it('accepts sums up to the limits exactly', () => {
    const narrow = newHist();
    narrow[1] = 0xffff_fffe;
    const one = newWideHist();
    one[1] = 1;
    expect(mergeInto(narrow, one)[1]).toBe(0xffff_ffff);
    const wide = newWideHist();
    wide[1] = Number.MAX_SAFE_INTEGER - 1;
    expect(mergeInto(wide, one)[1]).toBe(Number.MAX_SAFE_INTEGER);
  });
});
