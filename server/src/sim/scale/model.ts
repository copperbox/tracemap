/**
 * Traffic model for seeded history: traffic shape over time, rollup cells
 * with plausible latency histograms, and calibration of per-operation rates
 * and latencies from the same walker the load generator uses.
 *
 * Every value is a pure function of its inputs (no hidden state), so seeding
 * the same range twice writes the same rows.
 */
import { HIST_BUCKETS, bucketLowerMs, bucketOf } from '../../rollup/hist.js';
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

// ---- latency over time ----

const MIN = 60_000;
const TEN = 10 * MIN;

/** Uniform hash in [-sqrt(3), sqrt(3)): mean 0, standard deviation 1. */
const unitNoise = (a: number, b: number, salt: number) => (hashUnit(a, b, salt) - 0.5) * 2 * Math.sqrt(3);

/** Log-space value interpolated smoothly between anchors every `periodMs`, anchor k at offset + k * period. */
function wander(key: number, tMs: number, periodMs: number, offsetMs: number, sd: number, salt: number): number {
  const pos = (tMs - offsetMs) / periodMs;
  const k = Math.floor(pos);
  const f = (1 - Math.cos(Math.PI * (pos - k))) / 2;
  return sd * ((1 - f) * unitNoise(key, k, salt) + f * unitNoise(key, k + 1, salt));
}

/** Fleet-wide latency from load: 0.81 at the weekday low, 1.25 at the weekday peak. */
export function loadLatency(tMs: number): number {
  const s = trafficShape(tMs);
  return 0.8 + 0.45 * s * s;
}

/**
 * Latency multiplier for a node at time t, shared by `seed` (per cell) and
 * `load` (per node, refreshed every second), so seeded history runs into live
 * traffic without a step:
 * - rises with traffic through the day (the same curve for every node);
 * - a level that differs a little from day to day (sd 6%) and a slow wander
 *   with 10-minute anchors (sd 5%), both per team: most calls stay inside a
 *   team, so a service and the callees it waits on drift together, and a
 *   seeded operation (scaled as a whole) matches the live one (whose
 *   callees are scaled one by one). Nodes without a team drift on their own;
 * - per-minute noise per node (sd 4%) when `grainMs` is one minute. Coarser
 *   cells leave it out, because it averages away over ten or more minutes.
 * Incidents multiply on top (effectAt).
 */
export function latencyFactor(node: { idx: number; team: number | null }, tMs: number, grainMs = MIN): number {
  const mid = tMs + (grainMs === MIN ? 0 : grainMs / 2);
  const group = node.team ?? 1_000_000 + node.idx;
  let log = wander(group, mid, DAY, 12 * HOUR, 0.06, 21) + wander(group, mid, TEN, 0, 0.05, 22);
  if (grainMs <= MIN) log += 0.04 * unitNoise(node.idx, Math.floor(tMs / MIN), 23);
  return loadLatency(mid) * Math.exp(log);
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

/** CDF table value at a fractional boundary index, linear between boundaries. */
function cdfAt(cdf: ArrayLike<number>, j: number): number {
  if (j <= 0) return 0;
  if (j >= HIST_BUCKETS) return 1;
  const lo = Math.floor(j);
  const f = j - lo;
  return f === 0 ? cdf[lo] : cdf[lo] + (cdf[lo + 1] - cdf[lo]) * f;
}

/**
 * Spread n observations over the buckets of a CDF table shifted right by
 * `shift` buckets (latency multiplied by 1.1^shift; fractional shifts
 * interpolate between boundaries). Systematic rounding with offset u in
 * [0, 1): counts sum to exactly n and the expected count of each bucket is
 * exact. Adds into `out`.
 */
export function fillHist(out: Float64Array, cdf: ArrayLike<number>, n: number, shift: number, u: number): void {
  if (n <= 0) return;
  let prev = 0;
  for (let i = 0; i < HIST_BUCKETS; i++) {
    const cum = Math.floor(n * cdfAt(cdf, i + 1 - shift) + u);
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

/** Latency multiplier as a (fractional) number of histogram buckets. */
export function shiftFor(latMul: number): number {
  return latMul === 1 ? 0 : Math.log(latMul) / LN_GROWTH;
}

export interface Cell {
  n: number;
  err: number;
  sumMs: number;
}

/**
 * One rollup cell for a key. `key` and `bucket` make the noise deterministic.
 * expected = mean count for the cell; errP = failure probability; meanMs =
 * mean latency before `latMul`. Fills `hist` (if given) and returns n/err/sumMs.
 */
export function makeCell(
  key: number,
  bucket: number,
  expected: number,
  errP: number,
  meanMs: number,
  latMul: number,
  cdf: ArrayLike<number> | null,
  hist: Float64Array | null,
): Cell {
  const u1 = hashUnit(key, bucket, 1);
  const u2 = hashUnit(key, bucket, 2);
  const u3 = hashUnit(key, bucket, 3);
  const n = Math.max(0, Math.floor(expected * (0.85 + 0.3 * u1) + u2));
  const err = n > 0 ? Math.min(n, Math.floor(n * Math.min(1, Math.max(0, errP)) + u3)) : 0;
  const sumMs = n * meanMs * latMul;
  if (hist && cdf && n > 0) fillHist(hist, cdf, n, shiftFor(latMul), hashUnit(key, bucket, 4));
  return { n, err, sumMs };
}

// ---- calibration ----

export interface Calibration {
  traces: number;
  spansPerTrace: number;
  /** Per flat op index: requests per trace and mean server span duration (ms). */
  opRate: Float64Array;
  opMeanMs: Float64Array;
  /**
   * Per flat op index, CDF_STRIDE entries: the latency CDF at every histogram
   * bucket boundary (see lognormalCdfTable). In shared memory, so seed
   * workers read it without a copy each.
   */
  opCdf: Float32Array;
  /** The same per flat edge-op index, for the caller's client span. */
  edgeOpRate: Float64Array;
  edgeOpMeanMs: Float64Array;
  edgeOpCdf: Float32Array;
}

export const CDF_STRIDE = HIST_BUCKETS + 1;

/** CDF table of flat key `k` in a calibration CDF array. */
export function cdfOf(cdfs: Float32Array, k: number): Float32Array {
  return cdfs.subarray(k * CDF_STRIDE, (k + 1) * CDF_STRIDE);
}

/** Observations at which the empirical CDF and the lognormal prior weigh the same. */
const PRIOR_WEIGHT = 20;

/**
 * Run `traces` traces through the walker (no incidents, latency factor 1) and
 * measure, per operation and per edge operation, how often it occurs and its
 * latency distribution. The distribution is the empirical one (the walker's
 * spans are sums of lognormals, which a single lognormal fits poorly in the
 * tail), blended toward a lognormal fit, and for rarely seen keys toward the
 * node's own latency.
 */
export function calibrate(fleet: Fleet, traces: number, seed = fleet.config.seed): Calibration {
  const r = new Prng(subSeed(seed, 'calibrate'));
  const walker = new Walker(fleet, r);
  const buf = new TraceBuf();
  const nOp = fleet.opCount;
  const nEo = fleet.edgeOpCount;
  const acc = (n: number) => ({ n: new Float64Array(n), s: new Float64Array(n), s2: new Float64Array(n), ms: new Float64Array(n), hist: new Uint32Array(n * HIST_BUCKETS) });
  const op = acc(nOp);
  const eo = acc(nEo);
  let spans = 0;
  for (let t = 0; t < traces; t++) {
    walker.trace(buf);
    spans += buf.len;
    for (let i = 0; i < buf.len; i++) {
      const d = buf.durMs[i];
      const ld = Math.log(Math.max(0.01, d));
      const a = buf.edge[i] < 0 ? op : eo;
      const k = buf.edge[i] < 0 ? fleet.nodes[buf.node[i]].opBase + buf.op[i] : fleet.edges[buf.edge[i]].opBase + buf.op[i];
      a.n[k]++;
      a.s[k] += ld;
      a.s2[k] += ld * ld;
      a.ms[k] += d;
      a.hist[k * HIST_BUCKETS + bucketOf(d)]++;
    }
  }
  const fit = (x: ReturnType<typeof acc>, priorMu: (k: number) => number, priorSigma: (k: number) => number) => {
    const len = x.n.length;
    const rate = new Float64Array(len);
    const meanMs = new Float64Array(len);
    const cdf = new Float32Array(new SharedArrayBuffer(len * CDF_STRIDE * 4));
    for (let k = 0; k < len; k++) {
      const n = x.n[k];
      rate[k] = n / traces;
      let mu = priorMu(k);
      let sd = priorSigma(k);
      if (n >= 2) {
        const m = x.s[k] / n;
        const v = Math.max(0, x.s2[k] / n - m * m);
        const w = Math.min(1, n / 30);
        mu = w * m + (1 - w) * mu;
        sd = Math.max(0.15, w * Math.sqrt(v) + (1 - w) * sd);
      }
      const prior = lognormalCdfTable(mu, sd);
      const we = n / (n + PRIOR_WEIGHT);
      const out = cdfOf(cdf, k);
      let cum = 0;
      for (let i = 0; i <= HIST_BUCKETS; i++) {
        const emp = n > 0 ? cum / n : 0;
        out[i] = i === HIST_BUCKETS ? 1 : we * emp + (1 - we) * prior[i];
        if (i < HIST_BUCKETS) cum += x.hist[k * HIST_BUCKETS + i];
      }
      const priorMean = Math.exp(mu + (sd * sd) / 2);
      meanMs[k] = n > 0 ? we * (x.ms[k] / n) + (1 - we) * priorMean : priorMean;
    }
    return { rate, meanMs, cdf };
  };
  const opNode = new Int32Array(nOp);
  for (const n of fleet.nodes) for (let i = 0; i < n.ops.length; i++) opNode[n.opBase + i] = n.idx;
  const eoTarget = new Int32Array(nEo);
  for (const e of fleet.edges) for (let i = 0; i < e.ops.length; i++) eoTarget[e.opBase + i] = e.t;
  const ops = fit(op, (k) => Math.log(fleet.nodes[opNode[k]].selfMs * 1.5), (k) => fleet.nodes[opNode[k]].sigma);
  const eos = fit(eo, (k) => Math.log(fleet.nodes[eoTarget[k]].selfMs * 1.5), (k) => fleet.nodes[eoTarget[k]].sigma);
  return {
    traces,
    spansPerTrace: spans / traces,
    opRate: ops.rate,
    opMeanMs: ops.meanMs,
    opCdf: ops.cdf,
    edgeOpRate: eos.rate,
    edgeOpMeanMs: eos.meanMs,
    edgeOpCdf: eos.cdf,
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

/** Latency added per unit of incident error rate: +25% errors means 1.5x latency. */
export const ERROR_INCIDENT_LATENCY = 2;

/** Incident effect on a node over [from, to): overlap-weighted error add and latency multiplier. */
export function effectAt(windows: IncidentWindow[] | undefined, fromMs: number, toMs: number): { errAdd: number; latMul: number } {
  let errAdd = 0;
  let latMul = 1;
  if (!windows) return { errAdd, latMul };
  for (const w of windows) {
    const overlap = Math.min(toMs, w.endMs) - Math.max(fromMs, w.startMs);
    if (overlap <= 0) continue;
    const f = overlap / (toMs - fromMs);
    if (w.kind === 'error') {
      errAdd += w.magnitude * f;
      // Failing services are slow too: retries, timeouts, saturated pools.
      latMul *= 1 + ERROR_INCIDENT_LATENCY * w.magnitude * f;
    } else {
      latMul *= 1 + (w.magnitude - 1) * f;
    }
  }
  return { errAdd, latMul };
}
