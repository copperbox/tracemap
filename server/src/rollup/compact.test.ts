import { describe, expect, it } from 'vitest';
import { finalThrough1m, mergeRows, type SourceRow } from './compact.js';
import { addValue, encode, histTotal, newHist } from './hist.js';
import {
  bigintToSpanHex,
  hexToUuid,
  spanHexToBigint,
  spanWordsToBigint,
  upsertParams,
  upsertSql,
  uuidToHex,
} from './schema.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1, 12, 0);

function hist(...vals: number[]): Buffer {
  const h = newHist();
  for (const v of vals) addValue(h, v);
  return encode(h);
}

const row = (minute: number, keys: string[], n: number, err: number, h: Buffer | null, sample: string | null = null): SourceRow => ({
  bucket: new Date(T0 + minute * MIN),
  keys,
  n,
  err,
  sumMs: n * 10,
  hist: h,
  sample,
});

describe('mergeRows', () => {
  it('sums counts and merges histograms per target bucket and key, across collectors', () => {
    const rows = [
      row(0, ['a'], 2, 1, hist(1, 2)), // collector 1
      row(0, ['a'], 1, 0, hist(3)), // collector 2, same minute
      row(9, ['a'], 1, 0, hist(500)),
      row(10, ['a'], 4, 0, hist(1, 1, 1, 1)), // next 10m window
      row(5, ['b'], 1, 1, hist(7)),
    ];
    const m = mergeRows(rows, 10 * MIN);
    const byKey = new Map(m.keys.map((k, i) => [`${m.bucketMs[i] - T0}/${k[0]}`, i]));
    const a0 = byKey.get('0/a')!;
    expect([m.n[a0], m.err[a0], m.sumMs[a0]]).toEqual([4, 1, 40]);
    expect(histTotal(m.hist[a0]!)).toBe(4);
    const a1 = byKey.get(`${10 * MIN}/a`)!;
    expect(m.n[a1]).toBe(4);
    expect(m.n[byKey.get('0/b')!]).toBe(1);
    expect(m.bucketMs).toHaveLength(3);
  });

  it('picks the latest sample deterministically', () => {
    const u1 = '00000000-0000-0000-0000-000000000001';
    const u2 = '00000000-0000-0000-0000-000000000002';
    const rows = [row(1, ['a'], 1, 0, null, u2), row(3, ['a'], 1, 0, null, u1), row(2, ['a'], 1, 0, null, null)];
    expect(mergeRows(rows, 10 * MIN).sample[0]).toBe(uuidToHex(u1));
    expect(mergeRows([...rows].reverse(), 10 * MIN).sample[0]).toBe(uuidToHex(u1));
  });
});

describe('finalThrough1m', () => {
  it('lags now by the grace window plus two flushes', () => {
    expect(finalThrough1m(T0, 3, 10_000)).toBe(T0 - 3 * MIN - 20_000);
  });
});

describe('upsert SQL', () => {
  it('uses one array parameter per column and a scalar collector id at 1m', () => {
    const sql = upsertSql('op_rollup', '1m');
    expect(sql).toContain('INSERT INTO op_rollup_1m (bucket, collector_id, service_id, operation, n, err, sum_ms, hist)');
    expect(sql).toContain('unnest($1::timestamptz[], $2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::float8[], $7::bytea[])');
    expect(sql).toContain('$8::int');
    expect(sql).toContain('ON CONFLICT (bucket, collector_id, service_id, operation) DO UPDATE SET n = EXCLUDED.n');
    const params = upsertParams(
      'op_rollup',
      '1m',
      { bucketMs: [T0], keys: [['a', 'GET']], n: [1], err: [0], sumMs: [2], hist: [newHist()], sample: [null] },
      0,
      1,
      42,
    );
    expect(params).toHaveLength(8);
    expect(params[7]).toBe(42);
  });

  it('has no collector id above 1m and keeps an existing sample when none is sent', () => {
    const sql = upsertSql('svc_error_rollup', '1h');
    expect(sql).not.toContain('collector_id');
    expect(sql).toContain('COALESCE(EXCLUDED.sample_trace_id, svc_error_rollup_1h.sample_trace_id)');
  });

  it('maps trace ids to uuids and back', () => {
    const hex = '0123456789abcdef0123456789abcdef';
    expect(hexToUuid(hex)).toBe('01234567-89ab-cdef-0123-456789abcdef');
    expect(uuidToHex(hexToUuid(hex)!)).toBe(hex);
    expect(hexToUuid('abc')).toBeNull();
  });

  it('maps span ids to two-s complement bigints and back', () => {
    for (const hex of ['0000000000000001', '7fffffffffffffff', '8000000000000000', 'ffffffffffffffff', 'deadbeefcafef00d']) {
      const big = spanHexToBigint(hex);
      expect(bigintToSpanHex(big)).toBe(hex);
      expect(spanWordsToBigint(parseInt(hex.slice(0, 8), 16), parseInt(hex.slice(8), 16))).toBe(big);
    }
    expect(spanHexToBigint('ffffffffffffffff')).toBe('-1');
    expect(spanHexToBigint('8000000000000000')).toBe('-9223372036854775808');
  });
});
