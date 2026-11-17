/**
 * Shared metric helpers for the API. Live numbers come from the snapshot
 * (live/), history from the rollup reader (rollup/read.ts).
 */
import { quantile } from '../rollup/hist.js';
import { chooseBucketSeconds, type ReadRow } from '../rollup/read.js';

export { statusOf, type LiveMetrics } from '../live/metrics.js';
export { edgeConfidence } from '../live/structure.js';
export { roundMetrics, sig4, sig4OrNull } from '../live/round.js';
export type { Status } from '../live/frame.js';

/** Pick a chart bucket size (seconds) a rollup tier can serve, giving at most about 60 points. */
export function chartBucketSeconds(fromMs: number, toMs: number, nowMs = Date.now()): number {
  return chooseBucketSeconds(fromMs, toMs, nowMs);
}

const orNull = (v: number): number | null => (Number.isFinite(v) ? v : null);

/** Latency quantile of a merged row, ms; null without data. */
export function q(row: Pick<ReadRow, 'hist'> | undefined, p: number): number | null {
  return row?.hist ? orNull(quantile(row.hist, p)) : null;
}

/** Error spans as % of spans; null without spans. */
export function errPct(row: Pick<ReadRow, 'n' | 'err'> | undefined): number | null {
  return row && row.n > 0 ? (row.err / row.n) * 100 : null;
}
