import { describe, expect, it } from 'vitest';
import { HIST_BUCKETS, bucketOf, histTotal, quantile } from '../../rollup/hist.js';
import { buildFleet } from './fleet.js';
import { Prng } from './prng.js';
import { TraceBuf, Walker } from './walker.js';
import {
  CDF_STRIDE,
  calibrate,
  cdfOf,
  effectAt,
  fillHist,
  latencyFactor,
  loadLatency,
  lognormalCdfTable,
  makeCell,
  normCdf,
  shiftFor,
  splitCounts,
  trafficShape,
} from './model.js';

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

  it('shifts by fractions of a bucket, between the whole-bucket shifts', () => {
    const cdf = lognormalCdfTable(Math.log(10), 0.4);
    const p95 = (shift: number) => {
      const h = new Float64Array(HIST_BUCKETS);
      fillHist(h, cdf, 100_000, shift, 0.5);
      expect(histTotal(h)).toBe(100_000);
      return quantile(h, 0.95);
    };
    const [a, b, c] = [p95(2), p95(2.5), p95(3)];
    expect(b).toBeGreaterThanOrEqual(a);
    expect(b).toBeLessThanOrEqual(c);
    expect(shiftFor(1.1 ** 2.5)).toBeCloseTo(2.5, 9);
    expect(shiftFor(1)).toBe(0);
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
    const a = makeCell(7, 1000, 600, 0.01, 22, 1, cdf, h1);
    const b = makeCell(7, 1000, 600, 0.01, 22, 1, cdf, h2);
    expect(a).toEqual(b);
    expect(Array.from(h1)).toEqual(Array.from(h2));
    expect(a.n).toBeGreaterThanOrEqual(510);
    expect(a.n).toBeLessThanOrEqual(690);
    expect(histTotal(h1)).toBe(a.n);
    expect(a.err).toBeGreaterThanOrEqual(5);
    expect(a.err).toBeLessThanOrEqual(7);
    expect(a.sumMs).toBeCloseTo(a.n * 22, 6);
    expect(makeCell(7, 1000, 600, 0.01, 22, 1.5, null, null).sumMs).toBeCloseTo(a.n * 33, 6);
    let total = 0;
    for (let k = 0; k < 2000; k++) total += makeCell(k, 1, 0.3, 0, 10, 1, null, null).n;
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

  it('slows a service down during an error incident too', () => {
    expect(effectAt(w, 1000, 2000).latMul).toBeGreaterThan(1.3);
    expect(effectAt(w, 1500, 2500).latMul).toBeLessThan(effectAt(w, 1000, 2000).latMul);
  });
});

describe('latencyFactor', () => {
  const node = { idx: 42, team: 3 };
  const MIN = 60_000;

  it('rises with traffic through the day', () => {
    expect(loadLatency(at('2026-11-17T15:00:00Z'))).toBeCloseTo(1.25, 6);
    expect(loadLatency(at('2026-11-17T03:00:00Z'))).toBeCloseTo(0.818, 3);
    // Hourly averages, so the noise cannot decide it.
    const hourMean = (iso: string) => {
      let s = 0;
      for (let m = 0; m < 60; m++) s += latencyFactor(node, at(iso) + m * MIN);
      return s / 60;
    };
    expect(hourMean('2026-11-17T15:00:00Z') / hourMean('2026-11-17T03:00:00Z')).toBeGreaterThan(1.3);
  });

  it('is deterministic and varies from minute to minute', () => {
    const t = at('2026-11-17T10:00:00Z');
    expect(latencyFactor(node, t)).toBe(latencyFactor(node, t));
    const values = new Set<number>();
    for (let m = 0; m < 30; m++) values.add(Math.round(latencyFactor(node, t + m * MIN) * 1000));
    expect(values.size).toBeGreaterThan(15);
    for (const v of values) expect(Math.abs(v / 1000 / loadLatency(t) - 1)).toBeLessThan(0.4);
  });

  it('differs from day to day at the same time of day', () => {
    const days = Array.from({ length: 5 }, (_, d) => latencyFactor(node, at('2026-11-16T12:00:00Z') + d * 86_400_000, 600_000));
    expect(new Set(days.map((x) => x.toFixed(3))).size).toBe(5);
  });

  it('is continuous: neighboring minutes differ only by the per-minute noise', () => {
    const t = at('2026-11-17T10:00:00Z');
    for (let m = 0; m < 120; m++) {
      const r = latencyFactor(node, t + (m + 1) * MIN) / latencyFactor(node, t + m * MIN);
      expect(r).toBeGreaterThan(0.8);
      expect(r).toBeLessThan(1.25);
    }
  });

  it('leaves the per-minute noise out of coarse cells and shares the slow drift within a team', () => {
    const t = at('2026-11-17T10:00:00Z');
    const coarse = latencyFactor(node, t, 600_000);
    expect(latencyFactor({ idx: 7, team: 3 }, t, 600_000)).toBe(coarse);
    expect(latencyFactor({ idx: 7, team: 4 }, t, 600_000)).not.toBe(coarse);
    let mean = 0;
    for (let m = 0; m < 10; m++) mean += latencyFactor(node, t + m * MIN) / 10;
    expect(mean / coarse).toBeGreaterThan(0.95);
    expect(mean / coarse).toBeLessThan(1.05);
  });
});

describe('calibrate', () => {
  const fleet = buildFleet({ services: 120, teams: 4, seed: 3 });
  const calib = calibrate(fleet, 20_000);

  it('gives every key a monotone CDF from 0 to 1 in shared memory', () => {
    expect(calib.opCdf.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(calib.opCdf.length).toBe(fleet.opCount * CDF_STRIDE);
    expect(calib.edgeOpCdf.length).toBe(fleet.edgeOpCount * CDF_STRIDE);
    for (const cdfs of [calib.opCdf, calib.edgeOpCdf]) {
      for (let k = 0; k < cdfs.length / CDF_STRIDE; k++) {
        const c = cdfOf(cdfs, k);
        expect(c[0]).toBe(0);
        expect(c[HIST_BUCKETS]).toBe(1);
        for (let i = 1; i <= HIST_BUCKETS; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
      }
    }
  });

  it('reproduces the p95 the walker produces, which a lognormal fit misses', () => {
    // Fresh traces from another stream: what `load` would send.
    const walker = new Walker(fleet, new Prng(77));
    const buf = new TraceBuf();
    const live = new Map<number, Float64Array>();
    for (let t = 0; t < 20_000; t++) {
      walker.trace(buf);
      for (let i = 0; i < buf.len; i++) {
        if (buf.edge[i] >= 0) continue;
        const k = fleet.nodes[buf.node[i]].opBase + buf.op[i];
        const h = live.get(k) ?? live.set(k, new Float64Array(HIST_BUCKETS)).get(k)!;
        h[bucketOf(buf.durMs[i])]++;
      }
    }
    const ratios: number[] = [];
    for (const [k, h] of live) {
      if (histTotal(h) < 1000) continue;
      const seeded = new Float64Array(HIST_BUCKETS);
      fillHist(seeded, cdfOf(calib.opCdf, k), 100_000, 0, 0.5);
      ratios.push(quantile(seeded, 0.95) / quantile(h, 0.95));
    }
    // Each ratio carries the sampling noise of ~1,000 live spans and the 10% bucket width.
    expect(ratios.length).toBeGreaterThan(3);
    for (const r of ratios) expect(Math.abs(Math.log(r))).toBeLessThan(Math.log(1.25));
    ratios.sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    expect(median).toBeGreaterThan(0.95);
    expect(median).toBeLessThan(1.05);
  });
});
