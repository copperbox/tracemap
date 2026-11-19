import type pg from 'pg';
import { joinKey } from '../pipeline/keys.js';
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

/**
 * First half of the two-int advisory lock taken per rollup kind (second half:
 * the kind's index in ROLLUP_KINDS). Collectors hold it shared while they
 * write 1m rows and check the 10m watermark; compaction holds it exclusive
 * while it reads 1m rows and moves the watermark. So a 1m row is either seen
 * by the compaction that builds its window, or written after it and marked dirty.
 */
export const KIND_WRITE_LOCK_CLASS = 0x544d_4b31; // "TMK1"

const DIRTY_TABLE = 'rollup_dirty_windows';

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
    const gk = joinKey([String(bucketMs), ...r.keys]);
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
    // Counts come from bigint columns via Number(); past 2^53 they would round silently.
    if (!Number.isSafeInteger(g.n) || !Number.isSafeInteger(g.err)) {
      throw new RangeError(`rollup count beyond 2^53 - 1 for ${g.keys.join(', ')}`);
    }
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
  /** Dirty windows rebuilt per tier per run (all kinds together). Default 500. */
  maxRepairsPerRun?: number;
  /** Rows per upsert statement. */
  chunkRows: number;
}

export const DEFAULT_COMPACT_OPTIONS: Omit<CompactOptions, 'graceMinutes' | 'flushMs'> = {
  maxWindowsPerRun: { '10m': 36, '1h': 24, '1d': 7 },
  maxRepairsPerRun: 500,
  chunkRows: 10_000,
};

export interface CompactResult {
  /** False when another process held the lock. */
  ran: boolean;
  windows: number;
  /** Dirty windows rebuilt (late 1m rows, and the coarser windows above them). */
  repaired: number;
  rowsWritten: number;
  durationMs: number;
  /** Per "kind/tier": the new watermark. */
  watermarks: Record<string, string>;
}

/**
 * Time before which 1m rows normally no longer change: a minute leaves the
 * grace window `graceMinutes` after it starts and gets its last write within
 * one flush; one more flush interval is margin. A collector whose flush is
 * later than that (database outage) marks the windows it touches dirty, see
 * write1mRows().
 */
export function finalThrough1m(now: number, graceMinutes: number, flushMs: number): number {
  return now - graceMinutes * 60_000 - 2 * flushMs;
}

const kindIndex = (kind: RollupKindName): number => ROLLUP_KINDS.findIndex((k) => k.kind === kind);

/**
 * A collector's write of its 1m rows for one kind, in one transaction. Holds
 * the kind's write lock shared, so it cannot interleave with compaction of a
 * window. Rows that land in a 10m window compaction has already built mark
 * that window dirty; the next compaction rebuilds it (and the 1h and 1d
 * windows above it), so a flush that arrives late is never lost from the
 * coarser tiers.
 */
export async function write1mRows(
  pool: pg.Pool,
  kind: RollupKindName,
  rows: RollupRows,
  collectorId: number,
  chunkRows = 10_000,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared($1, $2)', [KIND_WRITE_LOCK_CLASS, kindIndex(kind)]);
    const sql = upsertSql(kind, '1m');
    const len = rows.bucketMs.length;
    for (let i = 0; i < len; i += chunkRows) {
      await client.query(sql, upsertParams(kind, '1m', rows, i, Math.min(i + chunkRows, len), collectorId));
    }
    const st = await client.query<{ c: Date }>(
      `SELECT compacted_through AS c FROM rollup_tier_state WHERE kind = $1 AND tier = '10m'`,
      [kind],
    );
    const wm = st.rows[0]?.c.getTime();
    if (wm != null) {
      const grain = tier('10m').grainMs;
      const windows = new Set<number>();
      for (const b of rows.bucketMs) {
        const w = bucketStart(b, grain);
        if (w < wm) windows.add(w);
      }
      if (windows.size) await markDirty(client, kind, '10m', [...windows]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function markDirty(client: pg.PoolClient, kind: RollupKindName, tierName: TierName, bucketsMs: number[]): Promise<void> {
  await client.query(
    `INSERT INTO ${DIRTY_TABLE} (kind, tier, bucket)
     SELECT $1, $2, b FROM unnest($3::timestamptz[]) AS b
     ON CONFLICT DO NOTHING`,
    [kind, tierName, bucketsMs.map((ms) => new Date(ms).toISOString())],
  );
}

/**
 * One run of tier compaction, single-flight across processes via a Postgres
 * advisory lock. First rebuilds dirty windows, finest tier first so a repair
 * cascades to 1d in the same run. Then builds 10m from 1m, 1h from 10m and 1d
 * from 1h for windows that are final in the tier below, advancing
 * rollup_tier_state. Idempotent: target rows are replaced, never incremented.
 */
export async function compactOnce(pool: pg.Pool, opts: CompactOptions, now = Date.now()): Promise<CompactResult> {
  const started = performance.now();
  const result: CompactResult = { ran: false, windows: 0, repaired: 0, rowsWritten: 0, durationMs: 0, watermarks: {} };
  const client = await pool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [COMPACTION_LOCK_KEY]);
    if (!lock.rows[0].ok) return result;
    result.ran = true;
    try {
      const state = await readState(client);
      await repairDirty(client, state, opts, result);
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

/** Rebuild marked windows, 10m then 1h then 1d, marking the window above when that tier already passed it. */
async function repairDirty(client: pg.PoolClient, state: Map<string, number>, opts: CompactOptions, result: CompactResult): Promise<void> {
  const limit = opts.maxRepairsPerRun ?? 500;
  for (let ti = 0; ti < TIERS.length; ti++) {
    const t = TIERS[ti];
    if (!t.source) continue;
    const src = tier(t.source);
    const parent = TIERS[ti + 1] ?? null;
    const marks = await client.query<{ kind: RollupKindName; bucket: Date }>(
      `SELECT kind, bucket FROM ${DIRTY_TABLE} WHERE tier = $1 ORDER BY bucket, kind LIMIT $2`,
      [t.name, limit],
    );
    for (const m of marks.rows) {
      const from = bucketStart(m.bucket.getTime(), t.grainMs);
      result.rowsWritten += await rebuildWindow(client, m.kind, src, t, from, opts.chunkRows, async () => {
        await client.query(`DELETE FROM ${DIRTY_TABLE} WHERE kind = $1 AND tier = $2 AND bucket = $3`, [m.kind, t.name, m.bucket]);
        if (!parent) return;
        const up = bucketStart(from, parent.grainMs);
        const parentWm = state.get(`${m.kind}/${parent.name}`);
        if (parentWm != null && up < parentWm) await markDirty(client, m.kind, parent.name, [up]);
      });
      result.repaired++;
    }
  }
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

/** Build one target window from its source rows and advance the watermark, atomically. */
export async function compactWindow(
  client: pg.PoolClient,
  kind: RollupKindName,
  src: Tier,
  target: Tier,
  fromMs: number,
  toMs: number,
  chunkRows = 10_000,
): Promise<number> {
  return rebuildWindow(client, kind, src, target, fromMs, chunkRows, () => writeState(client, kind, target.name, toMs));
}

/**
 * Replace one target window with the merge of its source rows, then run
 * `then` in the same transaction. Holds the kind's write lock exclusive from
 * before the source read until commit, so no collector write can slip
 * between the read and the watermark or marker change.
 */
async function rebuildWindow(
  client: pg.PoolClient,
  kind: RollupKindName,
  src: Tier,
  target: Tier,
  fromMs: number,
  chunkRows: number,
  then: () => Promise<unknown>,
): Promise<number> {
  const k = rollupKind(kind);
  const vals = valueColumns(k.shape);
  const toMs = fromMs + target.grainMs;
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [KIND_WRITE_LOCK_CLASS, kindIndex(kind)]);
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
    const sql = upsertSql(kind, target.name);
    for (let i = 0; i < merged.bucketMs.length; i += chunkRows) {
      await client.query(sql, upsertParams(kind, target.name, merged, i, Math.min(i + chunkRows, merged.bucketMs.length)));
    }
    await then();
    await client.query('COMMIT');
    return merged.bucketMs.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
