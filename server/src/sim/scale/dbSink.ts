/**
 * RowSink that writes seeded rollup rows with the collector's own batched
 * upsert (rollup/schema.ts): one statement per table chunk, unnest arrays,
 * idempotent.
 */
import type pg from 'pg';
import { HIST_BUCKETS } from '../../rollup/hist.js';
import { upsertParams, upsertSql, type RollupRows } from '../../rollup/schema.js';
import { tableName, tier as tierOf, type RollupKindName, type TierName } from '../../rollup/tiers.js';
import type { RowSink } from './seedGen.js';

class TableBuffer {
  readonly rows: RollupRows = { bucketMs: [], keys: [], n: [], err: [], sumMs: [], hist: [], sample: [] };
  /** Histogram slots reused between chunks: upsertParams encodes them synchronously. */
  private readonly pool: Float64Array[] = [];
  len = 0;

  constructor(
    readonly kind: RollupKindName,
    readonly tier: TierName,
    readonly sql: string,
  ) {}

  push(bucketMs: number, keys: string[], n: number, err: number, sumMs: number, hist: Float64Array | null): void {
    const i = this.len++;
    const r = this.rows;
    r.bucketMs[i] = bucketMs;
    r.keys[i] = keys;
    r.n[i] = n;
    r.err[i] = err;
    r.sumMs[i] = sumMs;
    r.sample[i] = null;
    if (hist) {
      const slot = (this.pool[i] ??= new Float64Array(HIST_BUCKETS));
      slot.set(hist);
      r.hist[i] = slot;
    } else {
      r.hist[i] = null;
    }
  }

  /** Build the statement's parameters and empty the buffer. */
  take(collectorId: number): unknown[] {
    const params = upsertParams(this.kind, this.tier, this.rows, 0, this.len, tierOf(this.tier).hasCollectorId ? collectorId : undefined);
    this.len = 0;
    return params;
  }
}

export class DbSink implements RowSink {
  private readonly buffers = new Map<string, TableBuffer>();
  private readonly pending = new Set<Promise<unknown>>();
  private failure: Error | null = null;
  /** Rows written per table. */
  readonly counts: Record<string, number> = {};

  constructor(
    /** Two connections let one chunk serialize while the previous one is written. */
    private readonly pool: pg.Pool,
    private readonly collectorId: number,
    private readonly chunkRows = 5_000,
  ) {}

  row(kind: RollupKindName, tier: TierName, bucketMs: number, keys: string[], n: number, err: number, sumMs: number, hist: Float64Array | null): void {
    const name = tableName(kind, tier);
    let buf = this.buffers.get(name);
    if (!buf) {
      buf = new TableBuffer(kind, tier, upsertSql(kind, tier));
      this.buffers.set(name, buf);
    }
    buf.push(bucketMs, keys, n, err, sumMs, hist);
    if (buf.len >= this.chunkRows) this.send(name, buf);
  }

  private send(name: string, buf: TableBuffer): void {
    const rows = buf.len;
    const p: Promise<unknown> = this.pool
      .query(buf.sql, buf.take(this.collectorId))
      .then(() => {
        this.counts[name] = (this.counts[name] ?? 0) + rows;
      })
      .catch((err: Error) => {
        this.failure ??= err;
      })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Wait until at most `max` statements are in flight. Throws the first write error. */
  async drain(max = 2): Promise<void> {
    while (this.pending.size > max) await Promise.race(this.pending);
    if (this.failure) throw this.failure;
  }

  /** Send what is buffered and wait for everything. */
  async finish(): Promise<void> {
    for (const [name, buf] of this.buffers) if (buf.len) this.send(name, buf);
    await this.drain(0);
  }
}
