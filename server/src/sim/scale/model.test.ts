import { describe, expect, it } from 'vitest';
import { HIST_BUCKETS, histTotal, quantile } from '../../rollup/hist.js';
import { effectAt, fillHist, lognormalCdfTable, makeCell, normCdf, splitCounts, trafficShape } from './model.js';

const at = (iso: string) => Date.parse(iso);

describe('trafficShape', () => {
  it('peaks at 15:00 UTC and bottoms out at 03:00 on weekdays', () => {
    // 2026-11-17 is a Tuesday.
    expect(trafficShape(at('2026-11-17T15:00:00Z'))).toBeCloseTo(1, 6);
    expect(trafficShape(at('2026-11-17T03:00:00Z'))).toBeCloseTo(0.2, 6);
    expect(trafficShape(at('2026-11-17T09:00:00Z'))).toBeCloseTo(0.6, 6);
  });

  it('is 30% lower on weekends', () => {
    expect(trafficShape(at('2026-11-21T15:00:00Z'))).toBeCloseTo(0.7, 6); // Saturday
    expect(trafficShape(at('2026-11-22T15:00:00Z'))).toBeCloseTo(0.7, 6); // Sunday
    expect(trafficShape(at('2026-11-23T15:00:00Z'))).toBeCloseTo(1, 6); // Monday
  });
});

describe('histogram generation', () => {
  it('normCdf is accurate', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normCdf(-1)).toBeCloseTo(0.158655, 5);
  });

  it('spreads exactly n observations around the lognormal median', () => {
    const cdf = lognormalCdfTable(Math.log(40), 0.5);
    const h = new Float64Array(HIST_BUCKETS);
    fillHist(h, cdf, 10_000, 0, 0.37);
    expect(histTotal(h)).toBe(10_000);
    for (const c of h) expect(Number.isInteger(c)).toBe(true);
    expect(quantile(h, 0.5)).toBeGreaterThan(40 / 1.1);
    expect(quantile(h, 0.5)).toBeLessThan(40 * 1.1);
    // p99 of a lognormal is median * exp(2.326 sigma).
    const p99 = 40 * Math.exp(2.326 * 0.5);
    expect(quantile(h, 0.99) / p99).toBeGreaterThan(0.9);
    expect(quantile(h, 0.99) / p99).toBeLessThan(1.1);
  });

  it('shifts latency by whole buckets', () => {
    const cdf = lognormalCdfTable(Math.log(10), 0.4);
    const a = new Float64Array(HIST_BUCKETS);
    const b = new Float64Array(HIST_BUCKETS);
    fillHist(a, cdf, 5000, 0, 0.5);
    fillHist(b, cdf, 5000, 8, 0.5);
    expect(quantile(b, 0.5) / quantile(a, 0.5)).toBeCloseTo(1.1 ** 8, 5);
    expect(histTotal(b)).toBe(5000);
  });

  it('keeps small counts exact', () => {
    const cdf = lognormalCdfTable(Math.log(5), 0.6);
    for (const n of [1, 2, 3, 7]) {
      const h = new Float64Array(HIST_BUCKETS);
      fillHist(h, cdf, n, 0, 0.9);
      expect(histTotal(h)).toBe(n);
    }
  });
});

describe('splitCounts', () => {
  it('splits a total across weights and sums exactly', () => {
    const out: number[] = [];
    splitCounts(100, Float64Array.from([5, 8, 10]), 0.3, out);
    expect(out.reduce((a, b) => a + b, 0)).toBe(100);
    expect(out[0]).toBeGreaterThanOrEqual(49);
    expect(out[0]).toBeLessThanOrEqual(51);
    splitCounts(1, Float64Array.from([5, 8, 10]), 0.99, out);
    expect(out.reduce((a, b) => a + b, 0)).toBe(1);
  });
});

describe('makeCell', () => {
  it('is deterministic per key and bucket and close to the expectation', () => {
    const cdf = lognormalCdfTable(Math.log(20), 0.5);
    const h1 = new Float64Array(HIST_BUCKETS);
    const h2 = new Float64Array(HIST_BUCKETS);
    const a = makeCell(7, 1000, 600, 0.01, Math.log(20), 0.5, 1, cdf, h1);
    const b = makeCell(7, 1000, 600, 0.01, Math.log(20), 0.5, 1, cdf, h2);
    expect(a).toEqual(b);
    expect(Array.from(h1)).toEqual(Array.from(h2));
    expect(a.n).toBeGreaterThanOrEqual(510);
    expect(a.n).toBeLessThanOrEqual(690);
    expect(histTotal(h1)).toBe(a.n);
    expect(a.err).toBeGreaterThanOrEqual(5);
    expect(a.err).toBeLessThanOrEqual(7);
    let total = 0;
    for (let k = 0; k < 2000; k++) total += makeCell(k, 1, 0.3, 0, 0, 0.5, 1, null, null).n;
    expect(total / 2000).toBeGreaterThan(0.25);
    expect(total / 2000).toBeLessThan(0.35);
  });
});

describe('effectAt', () => {
  const w = [{ node: 1, startMs: 1000, endMs: 2000, kind: 'error' as const, magnitude: 0.2 }];
  it('weights incident effects by overlap', () => {
    expect(effectAt(w, 0, 1000)).toEqual({ errAdd: 0, latMul: 1 });
    expect(effectAt(w, 1000, 2000).errAdd).toBeCloseTo(0.2);
    expect(effectAt(w, 1500, 2500).errAdd).toBeCloseTo(0.1);
    expect(effectAt([{ ...w[0], kind: 'latency', magnitude: 5 }], 1000, 2000).latMul).toBeCloseTo(5);
  });
});
