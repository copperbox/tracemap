import { quantile } from '../rollup/hist.js';
import type { LiveAggregate } from './cells.js';

/** Headline numbers for one service or edge over a window. */
export interface Summary {
  /** Spans per second over the window. */
  rps: number;
  /** Latency quantiles in ms; null when there were no spans. */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** Error spans as a percentage of spans, 0..100. */
  errPct: number;
}

const orNull = (v: number): number | null => (Number.isFinite(v) ? v : null);

/** Turn a live aggregate into rps / quantiles / error %, for a window of `seconds`. */
export function summarize(a: LiveAggregate, seconds: number): Summary {
  return {
    rps: a.n / Math.max(seconds, 1e-9),
    p50: orNull(quantile(a.hist, 0.5)),
    p95: orNull(quantile(a.hist, 0.95)),
    p99: orNull(quantile(a.hist, 0.99)),
    errPct: a.n ? (100 * a.err) / a.n : 0,
  };
}
