/**
 * Rollup reader: series and totals for any rollup kind, stitched across tiers.
 *
 * A read picks the coarsest tier whose grain divides the output bucket and
 * whose retention reaches back to the range start. That tier serves time up to
 * its compaction watermark; newer time comes from the next finer tier, down to
 * 1m, so a range ending now has no hole. Histograms are merged in Node.
 *
 * Ids are mapped to canonical at read time (merges only touch the catalog):
 * callers expand a canonical id to itself plus its aliases in the filter and
 * pass `canon` so rows recorded under an alias group with their service. An
 * edge whose two ends are now one service is dropped.
 */
import type pg from 'pg';
import { joinKey } from '../pipeline/keys.js';
import { decodeInto, mergeInto, newWideHist } from './hist.js';
import { uuidToHex } from './schema.js';
import { TIERS, rollupKind, tableName, valueColumns, type RollupKindName, type Tier, type TierName } from './tiers.js';

const SEC = 1000;

export interface Segment {
  tier: TierName;
  /** Rows with fromMs <= bucket < toMs. */
  fromMs: number;
  toMs: number;
}

/** compacted_through per tier for one kind; null when the tier has none yet. */
export type WatermarkFn = (tier: TierName) => number | null;

function covers(t: Tier, fromMs: number, nowMs: number): boolean {
  return t.retentionMs == null || fromMs >= nowMs - t.retentionMs;
}

/**
 * Which tier serves which part of [fromMs, toMs). fromMs should already be
 * aligned to the output bucket. Segments are contiguous, oldest first.
 */
export function planSegments(opts: {
  fromMs: number;
  toMs: number;
  bucketMs: number;
  nowMs: number;
  watermark: WatermarkFn;
}): Segment[] {
  const { fromMs, toMs, bucketMs, nowMs, watermark } = opts;
  if (!(toMs > fromMs)) return [];
  const usable = TIERS.filter((t) => bucketMs % t.grainMs === 0);
  if (!usable.length) throw new Error(`bucket ${bucketMs} ms is not a multiple of any tier grain`);
  let top = usable.length - 1;
  while (top > 0 && !covers(usable[top], fromMs, nowMs)) top--;
  const out: Segment[] = [];
  let cursor = fromMs;
  for (let i = top; i >= 0 && cursor < toMs; i--) {
    const t = usable[i];
    // 1m is written by the collectors and always current.
    const end = t.source === null ? toMs : Math.min(toMs, watermark(t.name) ?? -Infinity);
    if (end > cursor) {
      out.push({ tier: t.name, fromMs: cursor, toMs: end });
      cursor = end;
    }
  }
  return out;
}

/** Chart bucket candidates in seconds; each is a multiple of some tier grain. */
export const CHART_BUCKETS_SEC = [60, 120, 300, 600, 1200, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

/**
 * Bucket size (seconds) giving at most about 60 points for a range, and only
 * one some tier can serve: a short range that starts beyond 1m retention gets
 * a coarser bucket rather than an empty chart.
 */
export function chooseBucketSeconds(fromMs: number, toMs: number, nowMs = Date.now()): number {
  const rangeSec = Math.max(60, (toMs - fromMs) / SEC);
  for (const c of CHART_BUCKETS_SEC) {
    if (rangeSec / c > 60) continue;
    if (TIERS.some((t) => (c * SEC) % t.grainMs === 0 && covers(t, Math.floor(fromMs / (c * SEC)) * c * SEC, nowMs))) return c;
  }
  return 86400;
}

export interface BucketSlot {
  startMs: number;
  /** Seconds of the bucket that can hold data: shorter for the bucket containing now. */
  seconds: number;
}

/**
 * Output buckets for a range, time_bucket_gapfill style: one per bucket from
 * the bucket containing fromMs up to toMs. The newest bucket is included only
 * once at least `lagMs` (one rollup flush) has passed since it began, so the
 * right edge is never a bucket the collector cannot have written yet. Its rate
 * divisor ends `lagMs / 2` before now: the expected point the last flush covers.
 */
export function bucketSlots(fromMs: number, toMs: number, bucketMs: number, nowMs: number, lagMs: number): BucketSlot[] {
  const out: BucketSlot[] = [];
  const first = Math.floor(fromMs / bucketMs) * bucketMs;
  const dataEnd = nowMs - lagMs / 2;
  for (let b = first; b < toMs; b += bucketMs) {
    if (b > nowMs - lagMs) break;
    const end = Math.min(b + bucketMs, dataEnd);
    out.push({ startMs: b, seconds: Math.max(1, (end - b) / SEC) });
  }
  return out;
}

// ---- reading ----

export type KeyCol = 'service_id' | 'source_id' | 'target_id' | 'operation' | 'code' | 'message';

export interface ReadQuery {
  kind: RollupKindName;
  /** Column -> accepted values (matched with = ANY). */
  filter: Partial<Record<KeyCol, string[]>>;
  /** Key columns of the output rows (id columns come back canonical). */
  groupBy: KeyCol[];
  fromMs: number;
  toMs: number;
  /** Output bucket; must be a multiple of the 1m grain. */
  bucketMs: number;
  /** Merge latency histograms (red kinds only). Off reads pre-summed rows. */
  hist?: boolean;
}

/** A row as the store returns it: raw ids, any bucket inside the output bucket. */
export interface RawRow {
  bucketMs: number;
  keys: Partial<Record<KeyCol, string>>;
  n: number;
  err: number;
  sumMs: number;
  hist: Uint8Array | null;
  /** uuid */
  sample: string | null;
  /** Start of the source bucket the sample was recorded in; when absent, bucketMs. */
  sampleAtMs?: number | null;
}

export interface ReadRow {
  /** Output bucket start. */
  bucketMs: number;
  /** Values of ReadQuery.groupBy, in order. */
  keys: string[];
  n: number;
  err: number;
  sumMs: number;
  hist: Float64Array | null;
  /** 32-hex trace id of the newest sample in the group. */
  sample: string | null;
  /** Source bucket the sample was recorded in, so later regrouping can keep the newest. */
  sampleAtMs: number | null;
}

/** Where rows come from: SQL in production, an in-memory fake in tests. */
export interface RowSource {
  fetch(q: ReadQuery, segments: Segment[], groupCols: KeyCol[]): Promise<RawRow[]>;
  watermarks(kind: RollupKindName): Promise<WatermarkFn>;
}

const ID_COLS: readonly KeyCol[] = ['service_id', 'source_id', 'target_id'];

/** Columns the store must group by: the requested ones plus every id column of the kind. */
export function groupColumns(q: ReadQuery): KeyCol[] {
  const keys = rollupKind(q.kind).keys as readonly string[];
  const cols = new Set<KeyCol>(q.groupBy);
  for (const c of ID_COLS) if (keys.includes(c)) cols.add(c);
  return [...cols];
}

/**
 * Whether a sample recorded at `atMs` should replace the group's current one:
 * the newest wins, and a tie goes to the larger id so the pick does not depend
 * on row order.
 */
function newerSample(g: ReadRow, sample: string, atMs: number): boolean {
  if (g.sample == null || g.sampleAtMs == null) return true;
  return atMs > g.sampleAtMs || (atMs === g.sampleAtMs && sample > g.sample);
}

/**
 * Map ids to canonical, drop self-edges, regroup by (bucket, groupBy).
 * Samples keep the one recorded in the newest source bucket.
 */
export function aggregate(raw: RawRow[], q: ReadQuery, canon: (id: string) => string = (x) => x): ReadRow[] {
  const groups = new Map<string, ReadRow>();
  const isEdge = (rollupKind(q.kind).keys as readonly string[]).includes('source_id');
  for (const r of raw) {
    if (isEdge && canon(r.keys.source_id ?? '') === canon(r.keys.target_id ?? '')) continue;
    const bucketMs = Math.floor(r.bucketMs / q.bucketMs) * q.bucketMs;
    const keys = q.groupBy.map((c) => {
      const v = r.keys[c] ?? '';
      return ID_COLS.includes(c) ? canon(v) : v;
    });
    const gk = joinKey([String(bucketMs), ...keys]);
    let g = groups.get(gk);
    if (!g) {
      g = { bucketMs, keys, n: 0, err: 0, sumMs: 0, hist: null, sample: null, sampleAtMs: null };
      groups.set(gk, g);
    }
    g.n += r.n;
    g.err += r.err;
    g.sumMs += r.sumMs;
    if (r.hist && r.hist.length) decodeInto(r.hist, (g.hist ??= newWideHist()));
    if (r.sample) {
      const hex = uuidToHex(r.sample);
      const at = r.sampleAtMs ?? r.bucketMs;
      if (newerSample(g, hex, at)) {
        g.sample = hex;
        g.sampleAtMs = at;
      }
    }
  }
  return [...groups.values()];
}

/** Collapse buckets: one row per key, histograms merged, newest sample kept. */
export function sumBuckets(rows: ReadRow[]): ReadRow[] {
  const by = new Map<string, ReadRow>();
  for (const r of rows) {
    const k = joinKey(r.keys);
    let t = by.get(k);
    if (!t) {
      t = { bucketMs: r.bucketMs, keys: r.keys, n: 0, err: 0, sumMs: 0, hist: null, sample: null, sampleAtMs: null };
      by.set(k, t);
    }
    t.bucketMs = Math.min(t.bucketMs, r.bucketMs);
    t.n += r.n;
    t.err += r.err;
    t.sumMs += r.sumMs;
    if (r.hist) mergeInto((t.hist ??= newWideHist()), r.hist);
    if (r.sample) {
      const at = r.sampleAtMs ?? r.bucketMs;
      if (newerSample(t, r.sample, at)) {
        t.sample = r.sample;
        t.sampleAtMs = at;
      }
    }
  }
  return [...by.values()];
}

export interface ReaderOptions {
  now?: () => number;
  /** How far behind now the newest 1m rows can be: one rollup flush, ms. */
  lagMs: number;
}

export class RollupReader {
  private readonly now: () => number;

  constructor(
    private readonly source: RowSource,
    readonly opts: ReaderOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Rows per (output bucket, groupBy), stitched across tiers, ids canonical. */
  async read(q: ReadQuery, canon?: (id: string) => string): Promise<ReadRow[]> {
    const fromMs = Math.floor(q.fromMs / q.bucketMs) * q.bucketMs;
    const nowMs = this.now();
    const wm = await this.source.watermarks(q.kind);
    const segments = planSegments({ fromMs, toMs: Math.min(q.toMs, nowMs + 60_000), bucketMs: q.bucketMs, nowMs, watermark: wm });
    if (!segments.length) return [];
    const raw = await this.source.fetch({ ...q, fromMs }, segments, groupColumns(q));
    return aggregate(raw, q, canon);
  }

  /** One aggregate per groupBy key over the whole range (bucketMs still picks the tiers). */
  async totals(q: ReadQuery, canon?: (id: string) => string): Promise<ReadRow[]> {
    return sumBuckets(await this.read(q, canon));
  }

  /** Gap-filled output slots for a range, as read() buckets it. */
  slots(fromMs: number, toMs: number, bucketMs: number): BucketSlot[] {
    return bucketSlots(fromMs, toMs, bucketMs, this.now(), this.opts.lagMs);
  }
}

// ---- SQL source ----

type Db = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

/**
 * Rows from the rollup tables, one UNION ALL statement per read. Without
 * histograms the database sums per output bucket; with them raw rows come
 * back and are merged in Node.
 */
export class SqlRowSource implements RowSource {
  private wm: { at: number; data: Map<string, number> } | null = null;
  private wmLoading: Promise<Map<string, number>> | null = null;

  constructor(
    private readonly db: Db,
    private readonly watermarkTtlMs = 10_000,
  ) {}

  async watermarks(kind: RollupKindName): Promise<WatermarkFn> {
    const data = await this.loadWatermarks();
    return (t) => data.get(`${kind}/${t}`) ?? null;
  }

  /** Forget cached watermarks (tests). */
  resetWatermarks(): void {
    this.wm = null;
  }

  private async loadWatermarks(): Promise<Map<string, number>> {
    if (this.wm && Date.now() - this.wm.at < this.watermarkTtlMs) return this.wm.data;
    this.wmLoading ??= this.db('SELECT kind, tier, compacted_through FROM rollup_tier_state')
      .then((res) => {
        const data = new Map<string, number>();
        for (const r of res.rows as { kind: string; tier: string; compacted_through: Date }[]) {
          data.set(`${r.kind}/${r.tier}`, r.compacted_through.getTime());
        }
        this.wm = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        this.wmLoading = null;
      });
    return this.wmLoading;
  }

  async fetch(q: ReadQuery, segments: Segment[], groupCols: KeyCol[]): Promise<RawRow[]> {
    const { text, values } = buildSql(q, segments, groupCols);
    const res = await this.db(text, values);
    const vals = valueColumns(rollupKind(q.kind).shape);
    return (res.rows as Record<string, unknown>[]).map((r) => {
      const keys: Partial<Record<KeyCol, string>> = {};
      for (const c of groupCols) keys[c] = r[c] as string;
      return {
        bucketMs: Number(r.b),
        keys,
        n: Number(r.n),
        err: vals.includes('err') ? Number(r.err) : 0,
        sumMs: vals.includes('sum_ms') ? Number(r.sum_ms) : 0,
        hist: (r.hist as Buffer | undefined) ?? null,
        sample: (r.sample as string | undefined) ?? null,
        sampleAtMs: r.sample_at == null ? null : Number(r.sample_at),
      };
    });
  }
}

/** The UNION ALL statement for a read (exported for tests). */
export function buildSql(q: ReadQuery, segments: Segment[], groupCols: KeyCol[]): { text: string; values: unknown[] } {
  const k = rollupKind(q.kind);
  const vals = valueColumns(k.shape);
  const values: unknown[] = [q.bucketMs];
  const filters: string[] = [];
  for (const [col, list] of Object.entries(q.filter) as [KeyCol, string[]][]) {
    if (!(k.keys as readonly string[]).includes(col)) throw new Error(`${q.kind} has no column ${col}`);
    values.push(list);
    filters.push(`${col} = ANY($${values.length}::text[])`);
  }
  const withHist = !!q.hist && vals.includes('hist');
  const b = `(floor(extract(epoch FROM bucket) * 1000 / $1) * $1)::float8`;
  const cols = groupCols.join(', ');
  const parts = segments.map((s) => {
    values.push(new Date(s.fromMs), new Date(s.toMs));
    const where = [`bucket >= $${values.length - 1}`, `bucket < $${values.length}`, ...filters].join(' AND ');
    const table = tableName(q.kind, s.tier);
    if (withHist) {
      return `SELECT ${b} AS b, ${cols}, n, err, sum_ms, hist FROM ${table} WHERE ${where}`;
    }
    const agg = [
      'sum(n)::float8 AS n',
      vals.includes('err') ? 'sum(err)::float8 AS err' : null,
      vals.includes('sum_ms') ? 'sum(sum_ms) AS sum_ms' : null,
      vals.includes('sample_trace_id')
        ? '((array_agg(sample_trace_id ORDER BY bucket DESC, sample_trace_id DESC) FILTER (WHERE sample_trace_id IS NOT NULL))[1])::text AS sample'
        : null,
      vals.includes('sample_trace_id')
        ? '(extract(epoch FROM max(bucket) FILTER (WHERE sample_trace_id IS NOT NULL)) * 1000)::float8 AS sample_at'
        : null,
    ].filter(Boolean);
    return `SELECT ${b} AS b, ${cols}, ${agg.join(', ')} FROM ${table} WHERE ${where} GROUP BY 1, ${cols}`;
  });
  return { text: parts.join('\nUNION ALL\n'), values };
}
