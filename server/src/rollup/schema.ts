import { encode } from './hist.js';
import {
  rollupKind,
  tableName,
  tier,
  valueColumns,
  type RollupKindName,
  type TierName,
} from './tiers.js';

/**
 * Rows for one rollup table, column-wise. Arrays are parallel; `keys[i]` holds
 * row i's key values in ROLLUP_KINDS order. Fields a kind does not store are ignored.
 */
export interface RollupRows {
  bucketMs: number[];
  keys: string[][];
  n: number[];
  err: number[];
  sumMs: number[];
  hist: (ArrayLike<number> | null)[];
  /** 32-hex trace ids. */
  sample: (string | null)[];
}

const VALUE_TYPE: Record<string, string> = {
  n: 'bigint',
  err: 'bigint',
  sum_ms: 'float8',
  hist: 'bytea',
  sample_trace_id: 'uuid',
};

/**
 * Batched, idempotent upsert into `<kind>_<tier>`: one statement, one array
 * parameter per column (unnest), so the 65,535 bind-parameter limit never
 * applies. Values replace what is stored: callers always send whole rows.
 *
 * Parameters: $1 buckets, then one per key column, then one per value column,
 * then (1m only) the collector id as a scalar.
 */
export function upsertSql(kindName: RollupKindName, tierName: TierName): string {
  const k = rollupKind(kindName);
  const t = tier(tierName);
  const vals = valueColumns(k.shape);
  const table = tableName(kindName, tierName);
  const uCols = ['bucket', ...k.keys, ...vals];
  const types = ['timestamptz', ...k.keys.map(() => 'text'), ...vals.map((v) => VALUE_TYPE[v])];
  const unnestArgs = types.map((ty, i) => `$${i + 1}::${ty}[]`).join(', ');
  const collectorParam = `$${types.length + 1}::int`;
  const insertCols = ['bucket', ...(t.hasCollectorId ? ['collector_id'] : []), ...k.keys, ...vals];
  const selectCols = ['u.bucket', ...(t.hasCollectorId ? [collectorParam] : []), ...[...k.keys, ...vals].map((c) => `u.${c}`)];
  const pk = ['bucket', ...(t.hasCollectorId ? ['collector_id'] : []), ...k.keys];
  const sets = vals.map((v) =>
    v === 'sample_trace_id'
      ? `sample_trace_id = COALESCE(EXCLUDED.sample_trace_id, ${table}.sample_trace_id)`
      : `${v} = EXCLUDED.${v}`,
  );
  return `INSERT INTO ${table} (${insertCols.join(', ')})
SELECT ${selectCols.join(', ')}
FROM unnest(${unnestArgs}) AS u(${uCols.join(', ')})
ON CONFLICT (${pk.join(', ')}) DO UPDATE SET ${sets.join(', ')}`;
}

/** 32-hex trace id as a uuid string; null for anything else. */
export function hexToUuid(hex: string | null): string | null {
  if (!hex || hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** uuid string back to the 32-hex trace id used on the wire. */
export function uuidToHex(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase();
}

/**
 * Span id as stored in kept_spans: the 64-bit id read as a two's complement
 * bigint, returned as a decimal string for pg. Input is the id's two u32 words.
 */
export function spanWordsToBigint(hi: number, lo: number): string {
  return BigInt.asIntN(64, (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0)).toString();
}

/** 16-hex span id to its kept_spans bigint (decimal string). */
export function spanHexToBigint(hex: string): string {
  return BigInt.asIntN(64, BigInt('0x' + (hex || '0'))).toString();
}

/** kept_spans bigint (string or bigint, as pg returns it) back to the 16-hex span id. */
export function bigintToSpanHex(v: string | bigint): string {
  return BigInt.asUintN(64, BigInt(v)).toString(16).padStart(16, '0');
}

/** Parameters for upsertSql(kind, tier), rows [from, to). */
export function upsertParams(
  kindName: RollupKindName,
  tierName: TierName,
  rows: RollupRows,
  from = 0,
  to = rows.bucketMs.length,
  collectorId?: number,
): unknown[] {
  const k = rollupKind(kindName);
  const t = tier(tierName);
  const params: unknown[] = [rows.bucketMs.slice(from, to).map((ms) => new Date(ms).toISOString())];
  for (let ki = 0; ki < k.keys.length; ki++) {
    const col: string[] = new Array(to - from);
    for (let i = from; i < to; i++) col[i - from] = rows.keys[i][ki];
    params.push(col);
  }
  for (const v of valueColumns(k.shape)) {
    switch (v) {
      case 'n':
        params.push(rows.n.slice(from, to));
        break;
      case 'err':
        params.push(rows.err.slice(from, to));
        break;
      case 'sum_ms':
        params.push(rows.sumMs.slice(from, to));
        break;
      case 'hist':
        params.push(rows.hist.slice(from, to).map((h) => encode(h ?? [])));
        break;
      case 'sample_trace_id':
        params.push(rows.sample.slice(from, to).map(hexToUuid));
        break;
    }
  }
  if (t.hasCollectorId) {
    if (collectorId == null) throw new Error(`${tableName(kindName, tierName)} needs a collector id`);
    params.push(collectorId);
  }
  return params;
}
