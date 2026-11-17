import type { ReadQuery, ReadRow, RollupReader } from '../rollup/read.js';
import { errPct, q } from './metrics.js';

export interface SeriesPoint {
  t: string;
  rps: number | null;
  errPct: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/**
 * A gap-filled series (time_bucket_gapfill semantics: one point per bucket,
 * nulls where there is no data). Rates divide by the part of a bucket that
 * can hold data, so the bucket containing now is not shown as a dip.
 */
export async function readSeries(
  reader: RollupReader,
  query: Omit<ReadQuery, 'groupBy' | 'hist'>,
  canon: (id: string) => string,
): Promise<{ points: SeriesPoint[]; total: ReadRow | null }> {
  const rows = await reader.read({ ...query, groupBy: [], hist: true }, canon);
  const byBucket = new Map(rows.map((r) => [r.bucketMs, r]));
  const points = reader.slots(query.fromMs, query.toMs, query.bucketMs).map((slot) => {
    const r = byBucket.get(slot.startMs);
    return {
      t: new Date(slot.startMs).toISOString(),
      rps: r ? r.n / slot.seconds : null,
      errPct: errPct(r),
      p50: q(r, 0.5),
      p95: q(r, 0.95),
      p99: q(r, 0.99),
    };
  });
  let total: ReadRow | null = null;
  for (const r of rows) {
    total ??= { bucketMs: r.bucketMs, keys: [], n: 0, err: 0, sumMs: 0, hist: null, sample: null, sampleAtMs: null };
    total.n += r.n;
    total.err += r.err;
    total.sumMs += r.sumMs;
  }
  return { points, total };
}
