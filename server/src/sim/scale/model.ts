/**
 * Traffic model for seeded history: traffic shape over time, rollup cells
 * with plausible latency histograms, and calibration of per-operation rates
 * and latencies from the same walker the load generator uses.
 *
 * Every value is a pure function of its inputs (no hidden state), so seeding
 * the same range twice writes the same rows.
 */
import { HIST_BUCKETS, bucketLowerMs } from '../../rollup/hist.js';
import type { Fleet } from './fleet.js';
import { Prng, hashUnit, subSeed } from './prng.js';
import { TraceBuf, Walker } from './walker.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LN_GROWTH = Math.log(1.1);

/**
 * Relative traffic at time t (UTC ms): a daily curve peaking at 15:00 UTC
 * (0.2 at 03:00, 1.0 at 15:00) and 30% less on Saturday and Sunday.
 */
export function trafficShape(tMs: number): number {
  const hour = (tMs % DAY) / HOUR;
  const daily = 0.6 + 0.4 * Math.cos((2 * Math.PI * (hour - 15)) / 24);
  const weekday = (Math.floor(tMs / DAY) + 4) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
  return daily * (weekday === 0 || weekday === 6 ? 0.7 : 1);
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, error < 1.5e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/**
 * Lognormal CDF at every histogram bucket boundary: entry i is
 * P(duration < lower bound of bucket i), with entry 0 = 0 and entry 176 = 1
 * (values outside the range clamp into the end buckets, as hist.ts does).
 */
export function lognormalCdfTable(mu: number, sigma: number): Float64Array {
  const t = new Float64Array(HIST_BUCKETS + 1);
  for (let i = 1; i < HIST_BUCKETS; i++) t[i] = normCdf((Math.log(bucketLowerMs(i)) - mu) / sigma);
  t[HIST_BUCKETS] = 1;
  return t;
}

/**
 * Spread n observations over the buckets of a CDF table shifted right by
 * `shift` buckets (latency multiplied by 1.1^shift). Systematic rounding with
 * offset u in [0, 1): counts sum to exactly n and the expected count of each
 * bucket is exact. Adds into `out`.
 */
export function fillHist(out: Float64Array, cdf: Float64Array, n: number, shift: number, u: number): void {
  if (n <= 0) return;
  let prev = 0;
  for (let i = 0; i < HIST_BUCKETS; i++) {
    const j = i + 1 - shift;
    const c = j <= 0 ? 0 : j >= HIST_BUCKETS ? 1 : cdf[j];
    const cum = Math.floor(n * c + u);
    if (cum > prev) {
      out[i] += cum - prev;
      prev = cum;
    }
  }
  if (prev < n) out[HIST_BUCKETS - 1] += n - prev;
}

/** Split `total` across weights with systematic rounding (sums to total). */
export function splitCounts(total: number, cumWeights: Float64Array, u: number, out: number[]): void {
  const w = cumWeights[cumWeights.length - 1];
  let prev = 0;
  for (let j = 0; j < cumWeights.length; j++) {
    const cum = Math.floor((total * cumWeights[j]) / w + u);
    out[j] = Math.min(cum, total) - prev;
    prev = Math.min(cum, total);
  }
}

/** Latency multiplier as a whole number of histogram buckets. */
export function shiftFor(latMul: number): number {
  return latMul === 1 ? 0 : Math.round(Math.log(latMul) / LN_GROWTH);
}

export interface Cell {
  n: number;
  err: number;
  sumMs: number;
}

/**
 * One rollup cell for a key. `key` and `bucket` make the noise deterministic.
 * expected = mean count for the cell; errP = failure probability.
 * Fills `hist` (if given) and returns n/err/sumMs.
 */
export function makeCell(
  key: number,
  bucket: number,
  expected: number,
  errP: number,
  mu: number,
  sigma: number,
  latMul: number,
  cdf: Float64Array | null,
  hist: Float64Array | null,
): Cell {
  const u1 = hashUnit(key, bucket, 1);
  const u2 = hashUnit(key, bucket, 2);
  const u3 = hashUnit(key, bucket, 3);
  const n = Math.max(0, Math.floor(expected * (0.85 + 0.3 * u1) + u2));
  const err = n > 0 ? Math.min(n, Math.floor(n * Math.min(1, Math.max(0, errP)) + u3)) : 0;
  const sumMs = n * Math.exp(mu + (sigma * sigma) / 2) * latMul;
  if (hist && cdf && n > 0) fillHist(hist, cdf, n, shiftFor(latMul), hashUnit(key, bucket, 4));
  return { n, err, sumMs };
}

// ---- calibration ----

export interface Calibration {
  traces: number;
  spansPerTrace: number;
  /** Per flat op index: requests per trace, and log-ms mean / sd of the server span duration. */
  opRate: Float64Array;
  opMu: Float64Array;
  opSigma: Float64Array;
  /** Per flat edge-op index: calls per trace and log-ms mean / sd of the client span. */
  edgeOpRate: Float64Array;
  edgeOpMu: Float64Array;
  edgeOpSigma: Float64Array;
}

/**
 * Run `traces` traces through the walker (no incidents) and measure, per
 * operation and per edge operation, how often it occurs and how long it takes.
 * Keys seen fewer than 30 times blend toward the node's own latency.
 */
export function calibrate(fleet: Fleet, traces: number, seed = fleet.config.seed): Calibration {
  const r = new Prng(subSeed(seed, 'calibrate'));
  const walker = new Walker(fleet, r);
  const buf = new TraceBuf();
  const nOp = fleet.opCount;
  const nEo = fleet.edgeOpCount;
  const opN = new Float64Array(nOp);
  const opS = new Float64Array(nOp);
  const opS2 = new Float64Array(nOp);
  const eoN = new Float64Array(nEo);
  const eoS = new Float64Array(nEo);
  const eoS2 = new Float64Array(nEo);
  let spans = 0;
  for (let t = 0; t < traces; t++) {
    walker.trace(buf);
    spans += buf.len;
    for (let i = 0; i < buf.len; i++) {
      const ld = Math.log(Math.max(0.01, buf.durMs[i]));
      if (buf.edge[i] < 0) {
        const k = fleet.nodes[buf.node[i]].opBase + buf.op[i];
        opN[k]++;
        opS[k] += ld;
        opS2[k] += ld * ld;
      } else {
        const k = fleet.edges[buf.edge[i]].opBase + buf.op[i];
        eoN[k]++;
        eoS[k] += ld;
        eoS2[k] += ld * ld;
      }
    }
  }
  const fit = (n: Float64Array, s: Float64Array, s2: Float64Array, priorMu: (k: number) => number, priorSigma: (k: number) => number) => {
    const mu = new Float64Array(n.length);
    const sd = new Float64Array(n.length);
    const rate = new Float64Array(n.length);
    for (let k = 0; k < n.length; k++) {
      rate[k] = n[k] / traces;
      const pm = priorMu(k);
      const ps = priorSigma(k);
      if (n[k] >= 2) {
        const m = s[k] / n[k];
        const v = Math.max(0, s2[k] / n[k] - m * m);
        const w = Math.min(1, n[k] / 30);
        mu[k] = w * m + (1 - w) * pm;
        sd[k] = Math.max(0.15, w * Math.sqrt(v) + (1 - w) * ps);
      } else {
        mu[k] = pm;
        sd[k] = ps;
      }
    }
    return { rate, mu, sd };
  };
  const opNode = new Int32Array(nOp);
  for (const n of fleet.nodes) for (let i = 0; i < n.ops.length; i++) opNode[n.opBase + i] = n.idx;
  const eoTarget = new Int32Array(nEo);
  for (const e of fleet.edges) for (let i = 0; i < e.ops.length; i++) eoTarget[e.opBase + i] = e.t;
  const ops = fit(opN, opS, opS2, (k) => Math.log(fleet.nodes[opNode[k]].selfMs * 1.5), (k) => fleet.nodes[opNode[k]].sigma);
  const eos = fit(eoN, eoS, eoS2, (k) => Math.log(fleet.nodes[eoTarget[k]].selfMs * 1.5), (k) => fleet.nodes[eoTarget[k]].sigma);
  return {
    traces,
    spansPerTrace: spans / traces,
    opRate: ops.rate,
    opMu: ops.mu,
    opSigma: ops.sd,
    edgeOpRate: eos.rate,
    edgeOpMu: eos.mu,
    edgeOpSigma: eos.sd,
  };
}

// ---- incidents ----

export interface IncidentWindow {
  node: number;
  startMs: number;
  endMs: number;
  kind: 'error' | 'latency';
  magnitude: number;
}

/** Historical incidents placed relative to `anchorMs`. */
export function incidentWindows(fleet: Fleet, anchorMs: number): IncidentWindow[] {
  return fleet.incidents.map((i) => {
    const startMs = anchorMs - i.startMinAgo * 60_000;
    return { node: i.node, startMs, endMs: startMs + i.durationMin * 60_000, kind: i.kind, magnitude: i.magnitude };
  });
}

/** Incident effect on a node over [from, to): overlap-weighted error add and latency multiplier. */
export function effectAt(windows: IncidentWindow[] | undefined, fromMs: number, toMs: number): { errAdd: number; latMul: number } {
  let errAdd = 0;
  let latMul = 1;
  if (!windows) return { errAdd, latMul };
  for (const w of windows) {
    const overlap = Math.min(toMs, w.endMs) - Math.max(fromMs, w.startMs);
    if (overlap <= 0) continue;
    const f = overlap / (toMs - fromMs);
    if (w.kind === 'error') errAdd += w.magnitude * f;
    else latMul *= 1 + (w.magnitude - 1) * f;
  }
  return { errAdd, latMul };
}
