import type pg from 'pg';
import { decodeInto, newWideHist } from './hist.js';
import { upsertParams, upsertSql, uuidToHex, type RollupRows } from './schema.js';
import {
  ROLLUP_KINDS,
  TIERS,
  bucketStart,
  rollupKind,
  tableName,
  tier,
  valueColumns,
  type RollupKindName,
  type Tier,
  type TierName,
} from './tiers.js';

/** Advisory lock key, so only one process in the fleet compacts at a time. */
export const COMPACTION_LOCK_KEY = 0x544d_4331; // "TMC1"

/** A source row as read back from the tier below. */
export interface SourceRow {
  bucket: Date;
  keys: string[];
  n: number;
  err: number;
  sumMs: number;
  hist: Buffer | null;
  /** uuid string */
  sample: string | null;
}

/**
 * Merge source rows into rows of the target grain: sums n/err/sum_ms, merges
 * histograms bucket by bucket, collapses collector ids (they are not part of
 * `keys`). The sample trace id is taken from the latest source bucket that has
 * one, so a re-run over the same rows gives the same answer.
 */
export function mergeRows(rows: SourceRow[], grainMs: number): RollupRows {
  const groups = new Map<
    string,
    { bucketMs: number; keys: string[]; n: number; err: number; sumMs: number; hist: Float64Array | null; sample: string | null; sampleAt: number }
  >();
  for (const r of rows) {
    const bucketMs = bucketStart(r.bucket.getTime(), grainMs);
    const gk = bucketMs + '\u0001' + r.keys.join('\u0001');
    let g = groups.get(gk);
    if (!g) {
      g = { bucketMs, keys: r.keys, n: 0, err: 0, sumMs: 0, hist: null, sample: null, sampleAt: -Infinity };
      groups.set(gk, g);
    }
    g.n += r.n;
    g.err += r.err;
    g.sumMs += r.sumMs;
    if (r.hist) decodeInto(r.hist, (g.hist ??= newWideHist()));
    const at = r.bucket.getTime();
    if (r.sample && (at > g.sampleAt || (at === g.sampleAt && r.sample > (g.sample ?? '')))) {
      g.sample = r.sample;
      g.sampleAt = at;
    }
  }
  const out: RollupRows = { bucketMs: [], keys: [], n: [], err: [], sumMs: [], hist: [], sample: [] };
  for (const g of groups.values()) {
    out.bucketMs.push(g.bucketMs);
    out.keys.push(g.keys);
    out.n.push(g.n);
    out.err.push(g.err);
    out.sumMs.push(g.sumMs);
    out.hist.push(g.hist);
    out.sample.push(g.sample ? uuidToHex(g.sample) : null);
  }
  return out;
}

export interface CompactOptions {
  /** ROLLUP_GRACE_MINUTES: 1m rows are final this long after their minute, plus flush lag. */
  graceMinutes: number;
  /** ROLLUP_FLUSH_MS */
  flushMs: number;
  /** Target windows built per kind and tier per run, so catch-up after downtime is bounded. */
  maxWindowsPerRun: Partial<Record<TierName, number>>;
  /** Rows per upsert statement. */
  chunkRows: number;
}

export const DEFAULT_COMPACT_OPTIONS: Omit<CompactOptions, 'graceMinutes' | 'flushMs'> = {
  maxWindowsPerRun: { '10m': 36, '1h': 24, '1d': 7 },
  chunkRows: 10_000,
};

export interface CompactResult {
  /** False when another process held the lock. */
  ran: boolean;
  windows: number;
  rowsWritten: number;
  durationMs: number;
  /** Per "kind/tier": the new watermark. */
  watermarks: Record<string, string>;
}

/**
 * Time before which 1m rows can no longer change: a minute leaves the grace
 * window `graceMinutes` after it starts and gets its last write within one
 * flush; one more flush interval is margin.
 */
export function finalThrough1m(now: number, graceMinutes: number, flushMs: number): number {
  return now - graceMinutes * 60_000 - 2 * flushMs;
}

/**
 * Build 10m from 1m, 1h from 10m and 1d from 1h for every rollup kind, for
 * windows that are final in the tier below, advancing rollup_tier_state.
 * Single-flight across processes via a Postgres advisory lock. Idempotent:
 * target rows are replaced, never incremented.
 */
export async function compactOnce(pool: pg.Pool, opts: CompactOptions, now = Date.now()): Promise<CompactResult> {
  const started = performance.now();
  const result: CompactResult = { ran: false, windows: 0, rowsWritten: 0, durationMs: 0, watermarks: {} };
  const client = await pool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [COMPACTION_LOCK_KEY]);
    if (!lock.rows[0].ok) return result;
    result.ran = true;
    try {
      const state = await readState(client);
      for (const k of ROLLUP_KINDS) {
        for (const t of TIERS) {
          if (!t.source) continue;
          const src = tier(t.source);
          const readyThrough = src.source === null
            ? finalThrough1m(now, opts.graceMinutes, opts.flushMs)
            : state.get(`${k.kind}/${src.name}`);
          if (readyThrough == null) continue;
          const upper = bucketStart(readyThrough, t.grainMs);
          let wm: number = state.get(`${k.kind}/${t.name}`) ?? (await firstBucket(client, k.kind, src, t)) ?? upper;
          const maxWindows = opts.maxWindowsPerRun[t.name] ?? 24;
          let done = 0;
          while (wm < upper && done < maxWindows) {
            const next = wm + t.grainMs;
            result.rowsWritten += await compactWindow(client, k.kind, src, t, wm, next, opts.chunkRows);
            wm = next;
            done++;
          }
          if (done === 0 && !state.has(`${k.kind}/${t.name}`)) await writeState(client, k.kind, t.name, wm);
          state.set(`${k.kind}/${t.name}`, wm);
          result.windows += done;
          result.watermarks[`${k.kind}/${t.name}`] = new Date(wm).toISOString();
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [COMPACTION_LOCK_KEY]);
    }
  } finally {
    client.release();
    result.durationMs = performance.now() - started;
  }
  return result;
}

async function readState(client: pg.PoolClient): Promise<Map<string, number>> {
  const res = await client.query<{ kind: string; tier: string; compacted_through: Date }>(
    'SELECT kind, tier, compacted_through FROM rollup_tier_state',
  );
  return new Map(res.rows.map((r) => [`${r.kind}/${r.tier}`, r.compacted_through.getTime()]));
}

async function writeState(client: pg.PoolClient, kind: RollupKindName, tierName: TierName, ms: number): Promise<void> {
  await client.query(
    `INSERT INTO rollup_tier_state (kind, tier, compacted_through) VALUES ($1, $2, $3)
     ON CONFLICT (kind, tier) DO UPDATE SET compacted_through = EXCLUDED.compacted_through`,
    [kind, tierName, new Date(ms)],
  );
}

/** Where compaction starts when a tier has no watermark yet: the oldest source row. */
async function firstBucket(client: pg.PoolClient, kind: RollupKindName, src: Tier, target: Tier): Promise<number | null> {
  const res = await client.query<{ b: Date | null }>(`SELECT min(bucket) AS b FROM ${tableName(kind, src.name)}`);
  const b = res.rows[0]?.b;
  return b ? bucketStart(b.getTime(), target.grainMs) : null;
}

/** Rebuild one target window from its source rows and advance the watermark, atomically. */
export async function compactWindow(
  client: pg.PoolClient,
  kind: RollupKindName,
  src: Tier,
  target: Tier,
  fromMs: number,
  toMs: number,
  chunkRows = 10_000,
): Promise<number> {
  const k = rollupKind(kind);
  const vals = valueColumns(k.shape);
  const res = await client.query({
    text: `SELECT bucket, ${k.keys.join(', ')}, ${vals.join(', ')}
           FROM ${tableName(kind, src.name)} WHERE bucket >= $1 AND bucket < $2`,
    values: [new Date(fromMs), new Date(toMs)],
    rowMode: 'array',
  });
  const nk = k.keys.length;
  const idx = (c: string) => 1 + nk + vals.indexOf(c);
  const rows: SourceRow[] = res.rows.map((r: unknown[]) => ({
    bucket: r[0] as Date,
    keys: r.slice(1, 1 + nk) as string[],
    n: Number(r[idx('n')]),
    err: vals.includes('err') ? Number(r[idx('err')]) : 0,
    sumMs: vals.includes('sum_ms') ? Number(r[idx('sum_ms')]) : 0,
    hist: vals.includes('hist') ? (r[idx('hist')] as Buffer) : null,
    sample: vals.includes('sample_trace_id') ? (r[idx('sample_trace_id')] as string | null) : null,
  }));
  const merged = mergeRows(rows, target.grainMs);
  await client.query('BEGIN');
  try {
    const sql = upsertSql(kind, target.name);
    for (let i = 0; i < merged.bucketMs.length; i += chunkRows) {
      await client.query(sql, upsertParams(kind, target.name, merged, i, Math.min(i + chunkRows, merged.bucketMs.length)));
    }
    await writeState(client, kind, target.name, toMs);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
  return merged.bucketMs.length;
}
