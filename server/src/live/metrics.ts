import { mergeInto, newWideHist } from '../rollup/hist.js';
import type { LiveAggregate } from '../pipeline/cells.js';
import { summarize } from '../pipeline/summary.js';
import { splitEdgeKey } from '../pipeline/cells.js';
import { edgeKey } from './structure.js';
import type { Status } from './frame.js';

export interface LiveMetrics {
  rps: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  errPct: number;
  /** True when values come from the last observed window rather than right now. */
  stale: boolean;
}

export interface StatusedMetrics extends LiveMetrics {
  status: Status;
}

export function statusOf(errPct: number): Status {
  if (errPct > 2) return 'crit';
  if (errPct > 0.8) return 'warn';
  return 'ok';
}

export const EMPTY_METRICS: LiveMetrics = { rps: 0, p50: null, p95: null, p99: null, errPct: 0, stale: true };

const withStatus = (m: LiveMetrics): StatusedMetrics => ({ ...m, status: statusOf(m.errPct) });

function addAgg(into: Map<string, LiveAggregate>, key: string, a: LiveAggregate, copy: boolean): void {
  const cur = into.get(key);
  if (!cur) {
    // Copy only when the source map is not ours to mutate later.
    into.set(key, copy ? { n: a.n, err: a.err, sumMs: a.sumMs, hist: Float64Array.from(a.hist) } : a);
    return;
  }
  cur.n += a.n;
  cur.err += a.err;
  cur.sumMs += a.sumMs;
  mergeInto(cur.hist, a.hist);
}

/**
 * Regroup per-id aggregates under canonical ids. Two aliases of one service
 * sum; for edges (keys edgeKey(source, target)) an edge whose ends are now one
 * service is dropped. Takes ownership of the input aggregates (the pipeline
 * builds fresh ones per call), so merging into them is safe.
 */
export function canonicalize(
  entries: Map<string, LiveAggregate>,
  canon: (id: string) => string,
  isEdge: boolean,
): Map<string, LiveAggregate> {
  const out = new Map<string, LiveAggregate>();
  for (const [key, a] of entries) {
    let k: string;
    if (isEdge) {
      const [rs, rt] = splitEdgeKey(key);
      const s = canon(rs);
      const t = canon(rt);
      if (s === t) continue;
      k = edgeKey(s, t);
    } else {
      k = canon(key);
    }
    addAgg(out, k, a, false);
  }
  return out;
}

/**
 * Add `extra` (other collectors' rows, already canonical) into `into`, scaled
 * by `scale` so they count over the same seconds as the local window (a
 * restarted collector's window is shorter than the rows it inherits).
 */
export function addAggregates(into: Map<string, LiveAggregate>, extra: Map<string, LiveAggregate>, scale = 1): void {
  for (const [k, a] of extra) {
    if (scale === 1) {
      addAgg(into, k, a, true);
      continue;
    }
    const hist = Float64Array.from(a.hist, (c) => c * scale);
    addAgg(into, k, { n: a.n * scale, err: a.err * scale, sumMs: a.sumMs * scale, hist }, false);
  }
}

export interface LiveInputs {
  /** Service ids to report (the catalog), canonical. */
  serviceIds: Iterable<string>;
  /** Edge keys to report (the catalog), canonical. */
  edgeKeys: Iterable<string>;
  svc: Map<string, LiveAggregate>;
  svcSeconds: number;
  edges: Map<string, LiveAggregate>;
  edgeSeconds: number;
  /** Last known numbers, updated in place from live values. */
  lastSvc: Map<string, LiveMetrics>;
  lastEdge: Map<string, LiveMetrics>;
}

export interface LiveOutputs {
  services: Map<string, StatusedMetrics>;
  edges: Map<string, StatusedMetrics>;
}

/** Inbound aggregate for services without own telemetry: rps sums, error % weighted by rps. */
function fromInbound(list: LiveMetrics[], hist: Float64Array | null, n: number, err: number, seconds: number): LiveMetrics {
  if (hist) {
    const s = summarize({ n, err, sumMs: 0, hist }, seconds);
    return { ...s, stale: false };
  }
  let rps = 0;
  let errW = 0;
  let p50: number | null = null;
  let p95: number | null = null;
  let p99: number | null = null;
  const max = (a: number | null, b: number | null) => (b == null ? a : a == null ? b : Math.max(a, b));
  for (const m of list) {
    rps += m.rps;
    errW += (m.errPct / 100) * m.rps;
    p50 = max(p50, m.p50);
    p95 = max(p95, m.p95);
    p99 = max(p99, m.p99);
  }
  return { rps, p50, p95, p99, errPct: rps > 0 ? (errW / rps) * 100 : 0, stale: true };
}

/**
 * Current metrics for every catalog service and edge.
 *
 * A service's numbers come, in order of preference, from its own live spans,
 * from live calls into it (external services have no telemetry of their own,
 * and a service that went silent while callers still call it is better shown
 * by what they see), from its own last known numbers, from its callers' last
 * known numbers, else empty. Anything not live is flagged stale.
 */
export function computeLive(inp: LiveInputs): LiveOutputs {
  const edges = new Map<string, StatusedMetrics>();
  const liveEdgeMetrics = new Map<string, LiveMetrics>();
  for (const [k, a] of inp.edges) {
    const m: LiveMetrics = { ...summarize(a, inp.edgeSeconds), stale: false };
    liveEdgeMetrics.set(k, m);
    inp.lastEdge.set(k, { ...m, stale: true });
  }
  for (const k of inp.edgeKeys) {
    edges.set(k, withStatus(liveEdgeMetrics.get(k) ?? inp.lastEdge.get(k) ?? EMPTY_METRICS));
  }

  // Inbound live aggregates per target, histograms merged for real quantiles.
  const inboundLive = new Map<string, { n: number; err: number; hist: Float64Array }>();
  for (const [k, a] of inp.edges) {
    const t = splitEdgeKey(k)[1];
    let agg = inboundLive.get(t);
    if (!agg) {
      agg = { n: 0, err: 0, hist: newWideHist() };
      inboundLive.set(t, agg);
    }
    agg.n += a.n;
    agg.err += a.err;
    mergeInto(agg.hist, a.hist);
  }
  const inboundStale = new Map<string, LiveMetrics[]>();
  for (const [k, m] of inp.lastEdge) {
    const t = splitEdgeKey(k)[1];
    const list = inboundStale.get(t) ?? [];
    list.push(m);
    inboundStale.set(t, list);
  }

  const services = new Map<string, StatusedMetrics>();
  for (const id of inp.serviceIds) {
    const own = inp.svc.get(id);
    let m: LiveMetrics;
    if (own) {
      m = { ...summarize(own, inp.svcSeconds), stale: false };
      inp.lastSvc.set(id, { ...m, stale: true });
    } else if (inboundLive.has(id)) {
      const a = inboundLive.get(id)!;
      m = fromInbound([], a.hist, a.n, a.err, inp.edgeSeconds);
    } else if (inp.lastSvc.has(id)) {
      m = inp.lastSvc.get(id)!;
    } else if (inboundStale.has(id)) {
      m = fromInbound(inboundStale.get(id)!, null, 0, 0, 1);
    } else {
      m = EMPTY_METRICS;
    }
    services.set(id, withStatus(m));
  }
  return { services, edges };
}
