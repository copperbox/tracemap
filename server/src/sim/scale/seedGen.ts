/**
 * Seeded rollup rows for one node: its own service, operation and error
 * rollups (instrumented nodes) plus every edge it calls, at every tier the
 * seed plan covers. Pure: rows go to a sink, the caller decides where.
 *
 * Tiers are built the way compaction would build them: 1m cells for the
 * recent window, 10m cells (summed from the 1m ones where those exist), 1h
 * from 10m, 1d from 1h. So a reader stitching tiers sees consistent numbers.
 */
import { HIST_BUCKETS } from '../../rollup/hist.js';
import { bucketStart, type RollupKindName, type TierName } from '../../rollup/tiers.js';
import type { Fleet } from './fleet.js';
import {
  cdfOf,
  effectAt,
  latencyFactor,
  makeCell,
  splitCounts,
  trafficShape,
  type Calibration,
  type IncidentWindow,
} from './model.js';
import { hashUnit } from './prng.js';
import { callerSig, type Sig } from './signatures.js';

const MIN = 60_000;
const TEN = 10 * MIN;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface SeedPlan {
  /** Exclusive end of seeded 1m rows: the current minute. */
  anchorMs: number;
  /** First seeded bucket (a UTC midnight). */
  startMs: number;
  /** First seeded 1m bucket. */
  m0: number;
  /** Watermarks written to rollup_tier_state: tiers are seeded below these. */
  c10: number;
  c1h: number;
  c1d: number;
  /** 10m rows older than this are not written (outside 10m retention). */
  tenFrom: number;
  /** Traces per second "now"; history scales with trafficShape(). */
  tracesPerSec: number;
}

/**
 * Lay out the seeded range. The 10m/1h/1d watermarks match what tier
 * compaction would have reached by now, so compaction continues from them
 * using the seeded 1m rows and never rebuilds a seeded coarse window.
 */
export function planSeed(opts: {
  nowMs: number;
  days: number;
  recentMinutes: number;
  graceMinutes: number;
  flushMs: number;
  tracesPerSec: number;
}): SeedPlan {
  const anchorMs = bucketStart(opts.nowMs, MIN);
  const final1m = opts.nowMs - opts.graceMinutes * MIN - 2 * opts.flushMs;
  const c10 = bucketStart(final1m, TEN);
  const c1h = bucketStart(c10, HOUR);
  const c1d = bucketStart(c1h, DAY);
  const startMs = c1d - Math.max(0, Math.floor(opts.days)) * DAY;
  const recent = Math.min(Math.max(opts.recentMinutes, 20), 3 * 24 * 60 - 60);
  const m0 = Math.max(startMs, Math.min(c10, bucketStart(anchorMs - recent * MIN, TEN)));
  const tenFrom = bucketStart(opts.nowMs - 29 * DAY, DAY);
  return { anchorMs, startMs, m0, c10, c1h, c1d, tenFrom, tracesPerSec: opts.tracesPerSec };
}

export interface RowSink {
  row(kind: RollupKindName, tier: TierName, bucketMs: number, keys: string[], n: number, err: number, sumMs: number, hist: Float64Array | null): void;
}

export interface GenContext {
  fleet: Fleet;
  calib: Calibration;
  plan: SeedPlan;
  /** Incident windows by node. */
  incidents: Map<number, IncidentWindow[]>;
}

/** Minutes summed into LastMinute. */
export const LAST_MINUTES = 5;

/** Totals for one node over the last LAST_MINUTES seeded minutes, for the last-state tables. */
export interface LastMinute {
  svc: { n: number; err: number; hist: Float64Array } | null;
  edges: { edge: number; n: number; err: number; hist: Float64Array }[];
}

interface Series {
  kind: RollupKindName;
  keys: string[];
  hist: boolean;
}

/** Leaf generators: each produces one cell per bucket and adds into its parent series. */
interface Leaf {
  series: number;
  parent: number;
  key: number;
  ratePerSec: number;
  errBase: number;
  meanMs: number;
  cdf: Float32Array;
  /** Node whose incidents apply. */
  effectNode: number;
  /** Error series for each signature (cumulative weights in sigCum). */
  errSeries: number[];
  sigCum: Float64Array;
}

class Level {
  n: Float64Array;
  err: Float64Array;
  sum: Float64Array;
  hist: (Float64Array | null)[];
  constructor(series: Series[]) {
    const s = series.length;
    this.n = new Float64Array(s);
    this.err = new Float64Array(s);
    this.sum = new Float64Array(s);
    this.hist = series.map((x) => (x.hist ? new Float64Array(HIST_BUCKETS) : null));
  }
  clear(): void {
    this.n.fill(0);
    this.err.fill(0);
    this.sum.fill(0);
    for (const h of this.hist) h?.fill(0);
  }
  addFrom(o: Level): void {
    for (let i = 0; i < this.n.length; i++) {
      if (!o.n[i]) continue;
      this.n[i] += o.n[i];
      this.err[i] += o.err[i];
      this.sum[i] += o.sum[i];
      const h = this.hist[i];
      const oh = o.hist[i];
      if (h && oh) for (let b = 0; b < HIST_BUCKETS; b++) h[b] += oh[b];
    }
  }
}

function edgeSigs(fleet: Fleet, target: number): Sig[] {
  const t = fleet.nodes[target];
  if (!t.instrumented) return t.sigs;
  const byStatus = new Map<number, number>();
  for (const s of t.sigs) {
    const st = s.httpStatus ?? 500;
    byStatus.set(st, (byStatus.get(st) ?? 0) + s.weight);
  }
  return [...byStatus].map(([st, w]) => ({ ...callerSig(st), weight: w }));
}

function cumulative(sigs: Sig[]): Float64Array {
  const c = new Float64Array(sigs.length);
  let acc = 0;
  sigs.forEach((s, i) => (c[i] = acc += s.weight));
  return c;
}

/** Generate every seeded row owned by `nodeIdx`. Returns the last seeded minute's totals. */
export function genNode(ctx: GenContext, nodeIdx: number, sink: RowSink): LastMinute {
  const { fleet, calib, plan } = ctx;
  const node = fleet.nodes[nodeIdx];
  const series: Series[] = [];
  const leaves: Leaf[] = [];
  const add = (kind: RollupKindName, keys: string[], hist: boolean): number => series.push({ kind, keys, hist }) - 1;

  let svcSeries = -1;
  if (node.instrumented) {
    svcSeries = add('svc_rollup', [node.id], true);
    const sigCum = cumulative(node.sigs);
    node.ops.forEach((op, i) => {
      const k = node.opBase + i;
      if (calib.opRate[k] <= 0) return;
      const s = add('op_rollup', [node.id, op], true);
      const errSeries = node.sigs.map((sig) => add('svc_error_rollup', [node.id, op, sig.code, sig.message], false));
      leaves.push({
        series: s, parent: svcSeries, key: k, ratePerSec: calib.opRate[k] * plan.tracesPerSec, errBase: node.opErr[i],
        meanMs: calib.opMeanMs[k], cdf: cdfOf(calib.opCdf, k), effectNode: nodeIdx, errSeries, sigCum,
      });
    });
  }
  const edgeSeries: { edge: number; series: number }[] = [];
  for (const ei of fleet.out[nodeIdx]) {
    const e = fleet.edges[ei];
    const target = fleet.nodes[e.t];
    const es = add('edge_rollup', [node.id, target.id], true);
    edgeSeries.push({ edge: ei, series: es });
    const sigs = edgeSigs(fleet, e.t);
    const sigCum = cumulative(sigs);
    e.ops.forEach((op, j) => {
      const k = e.opBase + j;
      if (calib.edgeOpRate[k] <= 0) return;
      const s = add('edge_op_rollup', [node.id, target.id, op], false);
      const errSeries = sigs.map((sig) => add('edge_error_rollup', [node.id, target.id, op, sig.code, sig.message], false));
      leaves.push({
        series: s, parent: es, key: 10_000_000 + k, ratePerSec: calib.edgeOpRate[k] * plan.tracesPerSec,
        errBase: target.opErr[e.targetOps[j]], meanMs: calib.edgeOpMeanMs[k], cdf: cdfOf(calib.edgeOpCdf, k),
        effectNode: e.t, errSeries, sigCum,
      });
    });
  }

  const cur = new Level(series);
  const ten = new Level(series);
  const hour = new Level(series);
  const day = new Level(series);
  const scratch = new Float64Array(HIST_BUCKETS);
  const split: number[] = [];
  const shapeNow = trafficShape(plan.anchorMs);

  /** Fill `lvl` with fresh cells for [b, b + grain). */
  const compute = (lvl: Level, b: number, grain: number): void => {
    lvl.clear();
    const scale = (grain / 1000) * (trafficShape(b + grain / 2) / shapeNow);
    const bucketId = Math.floor(b / MIN);
    for (const leaf of leaves) {
      const fx = effectAt(ctx.incidents.get(leaf.effectNode), b, b + grain);
      const latMul = latencyFactor(fleet.nodes[leaf.effectNode], b, grain) * fx.latMul;
      const leafHist = series[leaf.series].hist ? lvl.hist[leaf.series]! : scratch;
      if (leafHist === scratch) scratch.fill(0);
      const c = makeCell(leaf.key, bucketId, leaf.ratePerSec * scale, leaf.errBase + fx.errAdd, leaf.meanMs, latMul, leaf.cdf, leafHist);
      if (!c.n) continue;
      lvl.n[leaf.series] += c.n;
      lvl.err[leaf.series] += c.err;
      lvl.sum[leaf.series] += c.sumMs;
      const p = leaf.parent;
      lvl.n[p] += c.n;
      lvl.err[p] += c.err;
      lvl.sum[p] += c.sumMs;
      const ph = lvl.hist[p]!;
      for (let i = 0; i < HIST_BUCKETS; i++) ph[i] += leafHist[i];
      if (c.err) {
        splitCounts(c.err, leaf.sigCum, hashUnit(leaf.key, bucketId, 5), split);
        for (let j = 0; j < leaf.errSeries.length; j++) lvl.n[leaf.errSeries[j]] += split[j];
      }
    }
  };

  const emit = (lvl: Level, tier: TierName, b: number): void => {
    for (let i = 0; i < series.length; i++) {
      if (!lvl.n[i]) continue;
      const s = series[i];
      sink.row(s.kind, tier, b, s.keys, lvl.n[i], lvl.err[i], lvl.sum[i], lvl.hist[i]);
    }
  };

  const recent = new Level(series);
  for (let w = plan.startMs; w < plan.anchorMs; w += TEN) {
    if (w + TEN > plan.m0) {
      ten.clear();
      for (let m = Math.max(w, plan.m0); m < Math.min(w + TEN, plan.anchorMs); m += MIN) {
        compute(cur, m, MIN);
        emit(cur, '1m', m);
        ten.addFrom(cur);
        if (m >= plan.anchorMs - LAST_MINUTES * MIN) recent.addFrom(cur);
      }
    } else {
      compute(ten, w, TEN);
    }
    if (w >= plan.c10) continue;
    if (w >= plan.tenFrom) emit(ten, '10m', w);
    hour.addFrom(ten);
    if ((w + TEN) % HOUR === 0) {
      const h = w + TEN - HOUR;
      if (h < plan.c1h) {
        emit(hour, '1h', h);
        day.addFrom(hour);
        if ((h + HOUR) % DAY === 0) {
          const d = h + HOUR - DAY;
          if (d < plan.c1d) emit(day, '1d', d);
          day.clear();
        }
      }
      hour.clear();
    }
  }
  return {
    svc: svcSeries >= 0 ? { n: recent.n[svcSeries], err: recent.err[svcSeries], hist: recent.hist[svcSeries]! } : null,
    edges: edgeSeries.map((es) => ({ edge: es.edge, n: recent.n[es.series], err: recent.err[es.series], hist: recent.hist[es.series]! })),
  };
}
