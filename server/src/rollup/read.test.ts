import { describe, expect, it } from 'vitest';
import { addValue, encode, newHist, quantile } from './hist.js';
import {
  RollupReader,
  aggregate,
  bucketSlots,
  buildSql,
  chooseBucketSeconds,
  groupColumns,
  planSegments,
  sumBuckets,
  type KeyCol,
  type RawRow,
  type ReadQuery,
  type RowSource,
  type Segment,
  type WatermarkFn,
} from './read.js';
import type { RollupKindName, TierName } from './tiers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// A fixed "now": 2026-11-17 13:47:23.5 UTC.
const NOW = Date.UTC(2026, 10, 17, 13, 47, 23, 500);

const wmOf = (m: Partial<Record<TierName, number>>): WatermarkFn => (t) => m[t] ?? null;

/** Typical steady state: compaction a few minutes behind each tier boundary. */
const steady = wmOf({
  '10m': Date.UTC(2026, 10, 17, 13, 40),
  '1h': Date.UTC(2026, 10, 17, 13, 0),
  '1d': Date.UTC(2026, 10, 17),
});

function assertContiguous(segs: Segment[], fromMs: number, toMs: number): void {
  expect(segs[0].fromMs).toBe(fromMs);
  expect(segs[segs.length - 1].toMs).toBe(toMs);
  for (let i = 1; i < segs.length; i++) expect(segs[i].fromMs).toBe(segs[i - 1].toMs);
}

describe('planSegments', () => {
  it('serves a 24h range ending now from 10m, then 1m past the 10m watermark', () => {
    const fromMs = Math.floor((NOW - DAY) / (30 * MIN)) * 30 * MIN;
    const segs = planSegments({ fromMs, toMs: NOW, bucketMs: 30 * MIN, nowMs: NOW, watermark: steady });
    expect(segs.map((s) => s.tier)).toEqual(['10m', '1m']);
    assertContiguous(segs, fromMs, NOW);
    expect(segs[0].toMs).toBe(Date.UTC(2026, 10, 17, 13, 40));
  });

  it('stitches 1h, 10m and 1m for a 7d range with 3h buckets', () => {
    const fromMs = Math.floor((NOW - 7 * DAY) / (3 * HOUR)) * 3 * HOUR;
    const segs = planSegments({ fromMs, toMs: NOW, bucketMs: 3 * HOUR, nowMs: NOW, watermark: steady });
    expect(segs.map((s) => s.tier)).toEqual(['1h', '10m', '1m']);
    assertContiguous(segs, fromMs, NOW);
    expect(segs[0].toMs).toBe(Date.UTC(2026, 10, 17, 13));
    expect(segs[1].toMs).toBe(Date.UTC(2026, 10, 17, 13, 40));
  });

  it('uses the daily tier for 30 days and stitches every finer tier after it', () => {
    const fromMs = Math.floor((NOW - 30 * DAY) / DAY) * DAY;
    const segs = planSegments({ fromMs, toMs: NOW, bucketMs: DAY, nowMs: NOW, watermark: steady });
    expect(segs.map((s) => s.tier)).toEqual(['1d', '1h', '10m', '1m']);
    assertContiguous(segs, fromMs, NOW);
  });

  it('skips a tier whose retention does not reach the range start', () => {
    // 4 days ago with 10m buckets: 1m (3 days) cannot serve the start, 10m can.
    const fromMs = NOW - 4 * DAY;
    const segs = planSegments({ fromMs, toMs: fromMs + 6 * HOUR, bucketMs: 10 * MIN, nowMs: NOW, watermark: steady });
    expect(segs).toEqual([{ tier: '10m', fromMs, toMs: fromMs + 6 * HOUR }]);
    // 40 days ago with 1h buckets: 10m (30 days) is out, 1h serves it.
    const old = NOW - 40 * DAY;
    expect(planSegments({ fromMs: old, toMs: old + DAY, bucketMs: HOUR, nowMs: NOW, watermark: steady })).toEqual([
      { tier: '1h', fromMs: old, toMs: old + DAY },
    ]);
  });

  it('falls back to the finest tier when no tier with a dividing grain covers the start', () => {
    const fromMs = NOW - 5 * DAY;
    const segs = planSegments({ fromMs, toMs: fromMs + HOUR, bucketMs: MIN, nowMs: NOW, watermark: steady });
    expect(segs).toEqual([{ tier: '1m', fromMs, toMs: fromMs + HOUR }]);
  });

  it('reads everything from 1m when nothing has been compacted yet', () => {
    const fromMs = NOW - DAY;
    const segs = planSegments({ fromMs, toMs: NOW, bucketMs: HOUR, nowMs: NOW, watermark: wmOf({}) });
    expect(segs).toEqual([{ tier: '1m', fromMs, toMs: NOW }]);
  });

  it('serves a historical range entirely from the coarse tier', () => {
    const fromMs = Date.UTC(2026, 10, 10);
    const segs = planSegments({ fromMs, toMs: fromMs + DAY, bucketMs: HOUR, nowMs: NOW, watermark: steady });
    expect(segs).toEqual([{ tier: '1h', fromMs, toMs: fromMs + DAY }]);
  });

  it('returns nothing for an empty or inverted range', () => {
    expect(planSegments({ fromMs: NOW, toMs: NOW, bucketMs: MIN, nowMs: NOW, watermark: steady })).toEqual([]);
  });

  it('rejects a bucket no tier can build', () => {
    expect(() => planSegments({ fromMs: 0, toMs: MIN, bucketMs: 30_000, nowMs: NOW, watermark: steady })).toThrow();
  });
});

describe('chooseBucketSeconds', () => {
  it('aligns with tier grains and gives at most about 60 points', () => {
    expect(chooseBucketSeconds(NOW - HOUR, NOW, NOW)).toBe(60);
    expect(chooseBucketSeconds(NOW - 6 * HOUR, NOW, NOW)).toBe(600);
    expect(chooseBucketSeconds(NOW - DAY, NOW, NOW)).toBe(1800);
    expect(chooseBucketSeconds(NOW - 7 * DAY, NOW, NOW)).toBe(10800);
    expect(chooseBucketSeconds(NOW - 30 * DAY, NOW, NOW)).toBe(43200);
  });

  it('coarsens a short range that starts beyond 1m retention', () => {
    const from = NOW - 5 * DAY;
    expect(chooseBucketSeconds(from, from + HOUR, NOW)).toBe(600);
    const older = NOW - 60 * DAY;
    expect(chooseBucketSeconds(older, older + HOUR, NOW)).toBe(3600);
  });
});

describe('bucketSlots', () => {
  it('gap-fills from the bucket containing the start, rate divisor shortened at now', () => {
    const slots = bucketSlots(NOW - 3 * HOUR, NOW, HOUR, NOW, 10_000);
    expect(slots.map((s) => new Date(s.startMs).toISOString())).toEqual([
      '2026-11-17T10:00:00.000Z',
      '2026-11-17T11:00:00.000Z',
      '2026-11-17T12:00:00.000Z',
      '2026-11-17T13:00:00.000Z',
    ]);
    expect(slots[0].seconds).toBe(3600);
    // 47m23.5s into the hour, minus half a flush.
    expect(slots[3].seconds).toBeCloseTo(47 * 60 + 23.5 - 5, 6);
  });

  it('leaves out a bucket the collector cannot have flushed yet', () => {
    const justStarted = Date.UTC(2026, 10, 17, 13, 47, 4);
    const slots = bucketSlots(justStarted - 5 * MIN, justStarted, MIN, justStarted, 10_000);
    expect(new Date(slots[slots.length - 1].startMs).toISOString()).toBe('2026-11-17T13:46:00.000Z');
  });

  it('is exact for a range in the past', () => {
    const to = Date.UTC(2026, 10, 1);
    const slots = bucketSlots(to - DAY, to, HOUR, NOW, 10_000);
    expect(slots).toHaveLength(24);
    expect(slots.every((s) => s.seconds === 3600)).toBe(true);
  });
});

// ---- reader against a fake store ----

interface FakeRow {
  tier: TierName;
  bucketMs: number;
  keys: Partial<Record<KeyCol, string>>;
  n: number;
  err: number;
  ms?: number[];
  sample?: string;
}

/** In-memory tiers: applies segments and filters the way the SQL does, records what was asked. */
function fakeSource(rows: FakeRow[], wm: WatermarkFn) {
  const calls: Segment[][] = [];
  const source: RowSource = {
    async watermarks(_kind: RollupKindName) {
      return wm;
    },
    async fetch(q: ReadQuery, segments: Segment[]): Promise<RawRow[]> {
      calls.push(segments);
      const out: RawRow[] = [];
      for (const s of segments) {
        for (const r of rows) {
          if (r.tier !== s.tier || r.bucketMs < s.fromMs || r.bucketMs >= s.toMs) continue;
          if (!Object.entries(q.filter).every(([c, list]) => list!.includes(r.keys[c as KeyCol] ?? ''))) continue;
          let hist: Uint8Array | null = null;
          if (r.ms) {
            const h = newHist();
            for (const v of r.ms) addValue(h, v);
            hist = encode(h);
          }
          out.push({ bucketMs: r.bucketMs, keys: r.keys, n: r.n, err: r.err, sumMs: 0, hist, sample: r.sample ?? null });
        }
      }
      return out;
    },
  };
  return { source, calls };
}

/** One row per minute/10m/hour across the tiers, each n=1, so a sum counts covered grains. */
function fill(tier: TierName, fromMs: number, toMs: number, grain: number, keys: FakeRow['keys'], n = 1): FakeRow[] {
  const out: FakeRow[] = [];
  for (let b = fromMs; b < toMs; b += grain) out.push({ tier, bucketMs: b, keys, n, err: 0 });
  return out;
}

describe('RollupReader', () => {
  const a = { service_id: 'a' };

  it('stitches tiers without double counting or leaving a hole at the right edge', async () => {
    // Every tier holds the same traffic (1 span per minute) up to its watermark;
    // the 1m tier holds it right up to now. A correct read counts each minute once.
    const w10 = Date.UTC(2026, 10, 17, 13, 40);
    const w1h = Date.UTC(2026, 10, 17, 13);
    const start = NOW - 8 * DAY;
    const rows = [
      ...fill('1h', Math.floor(start / HOUR) * HOUR, w1h, HOUR, a, 60),
      ...fill('10m', Math.floor((NOW - 29 * DAY) / (10 * MIN)) * 10 * MIN, w10, 10 * MIN, a, 10),
      ...fill('1m', Math.floor((NOW - 3 * DAY) / MIN) * MIN, Math.floor(NOW / MIN) * MIN + MIN, MIN, a, 1),
    ];
    const { source } = fakeSource(rows, wmOf({ '10m': w10, '1h': w1h }));
    const reader = new RollupReader(source, { now: () => NOW, lagMs: 10_000 });

    const fromMs = NOW - 7 * DAY;
    const bucketMs = 3 * HOUR;
    const read = await reader.read({ kind: 'svc_rollup', filter: { service_id: ['a'] }, groupBy: [], fromMs, toMs: NOW, bucketMs });
    const byBucket = new Map(read.map((r) => [r.bucketMs, r.n]));
    const slots = reader.slots(fromMs, NOW, bucketMs);
    for (const s of slots.slice(0, -1)) expect(byBucket.get(s.startMs)).toBe(180);
    // The open bucket holds exactly the minutes so far (12:00 to 13:47 inclusive).
    const last = slots[slots.length - 1];
    expect(new Date(last.startMs).toISOString()).toBe('2026-11-17T12:00:00.000Z');
    expect(byBucket.get(last.startMs)).toBe(108);
  });

  it('expands nothing it was not asked for and maps aliases to canonical when grouping', async () => {
    const rows: FakeRow[] = [
      { tier: '1m', bucketMs: NOW - 5 * MIN, keys: { service_id: 'a' }, n: 3, err: 1, ms: [10, 10, 10] },
      { tier: '1m', bucketMs: NOW - 5 * MIN, keys: { service_id: 'a-old' }, n: 2, err: 1, ms: [1000, 1000] },
      { tier: '1m', bucketMs: NOW - 5 * MIN, keys: { service_id: 'b' }, n: 7, err: 0 },
    ];
    const { source } = fakeSource(rows, wmOf({}));
    const reader = new RollupReader(source, { now: () => NOW, lagMs: 10_000 });
    const canon = (id: string) => (id === 'a-old' ? 'a' : id);
    const got = await reader.totals(
      { kind: 'svc_rollup', filter: { service_id: ['a', 'a-old'] }, groupBy: ['service_id'], fromMs: NOW - HOUR, toMs: NOW, bucketMs: MIN, hist: true },
      canon,
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ keys: ['a'], n: 5, err: 2 });
    expect(quantile(got[0].hist!, 0.99)).toBeGreaterThan(900);
  });

  it('drops an edge whose ends are now one service and sums parallel alias edges', async () => {
    const t = NOW - 10 * MIN;
    const rows: FakeRow[] = [
      { tier: '1m', bucketMs: t, keys: { source_id: 'a', target_id: 'a-old' }, n: 4, err: 0 },
      { tier: '1m', bucketMs: t, keys: { source_id: 'x', target_id: 'a' }, n: 1, err: 0 },
      { tier: '1m', bucketMs: t, keys: { source_id: 'x', target_id: 'a-old' }, n: 2, err: 1 },
    ];
    const { source } = fakeSource(rows, wmOf({}));
    const reader = new RollupReader(source, { now: () => NOW, lagMs: 10_000 });
    const canon = (id: string) => (id === 'a-old' ? 'a' : id);
    const got = await reader.totals(
      { kind: 'edge_rollup', filter: {}, groupBy: ['source_id', 'target_id'], fromMs: NOW - HOUR, toMs: NOW, bucketMs: MIN },
      canon,
    );
    expect(got).toEqual([expect.objectContaining({ keys: ['x', 'a'], n: 3, err: 1 })]);
  });

  it('keeps the newest sample trace per group', async () => {
    const rows: FakeRow[] = [
      { tier: '1m', bucketMs: NOW - 9 * MIN, keys: { service_id: 'a', operation: 'GET', code: 'E', message: '' }, n: 1, err: 0, sample: '00000000-0000-0000-0000-000000000001' },
      { tier: '1m', bucketMs: NOW - 2 * MIN, keys: { service_id: 'a', operation: 'GET', code: 'E', message: '' }, n: 1, err: 0, sample: '00000000-0000-0000-0000-000000000002' },
      { tier: '1m', bucketMs: NOW - MIN, keys: { service_id: 'a', operation: 'GET', code: 'E', message: '' }, n: 1, err: 0 },
    ];
    const { source } = fakeSource(rows, wmOf({}));
    const reader = new RollupReader(source, { now: () => NOW, lagMs: 10_000 });
    const got = await reader.totals({
      kind: 'svc_error_rollup',
      filter: { service_id: ['a'] },
      groupBy: ['operation', 'code', 'message'],
      fromMs: NOW - HOUR,
      toMs: NOW,
      bucketMs: MIN,
    });
    expect(got).toEqual([expect.objectContaining({ n: 3, sample: '00000000000000000000000000000002' })]);
  });

  it('keeps the sample recorded last when aliases or tiers share an output bucket', async () => {
    const u = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
    const raw = (keys: RawRow['keys'], sample: string, sampleAtMs: number): RawRow => ({
      bucketMs: 0,
      keys,
      n: 1,
      err: 0,
      sumMs: 0,
      hist: null,
      sample,
      sampleAtMs,
    });
    const q: ReadQuery = { kind: 'svc_error_rollup', filter: {}, groupBy: ['operation'], fromMs: 0, toMs: DAY, bucketMs: DAY };
    const canon = (id: string) => (id === 'a-old' ? 'a' : id);
    const rows = [
      raw({ service_id: 'a', operation: 'GET' }, u(1), 10 * MIN),
      raw({ service_id: 'a-old', operation: 'GET' }, u(2), 50 * MIN),
      raw({ service_id: 'a', operation: 'GET' }, u(3), 20 * MIN),
    ];
    for (const order of [rows, [...rows].reverse()]) {
      const got = aggregate(order, q, canon);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ n: 3, sample: '00000000000000000000000000000002', sampleAtMs: 50 * MIN });
    }
    // Same time: the larger id wins whatever the order.
    const tie = [raw({ service_id: 'a', operation: 'GET' }, u(4), MIN), raw({ service_id: 'a-old', operation: 'GET' }, u(5), MIN)];
    expect(aggregate(tie, q, canon)[0].sample).toBe('00000000000000000000000000000005');
    expect(aggregate([...tie].reverse(), q, canon)[0].sample).toBe('00000000000000000000000000000005');
  });

  it('does not merge groups whose keys only differ in where a separator falls', () => {
    const raw = (operation: string, code: string): RawRow => ({ bucketMs: 0, keys: { operation, code }, n: 1, err: 0, sumMs: 0, hist: null, sample: null });
    const q: ReadQuery = { kind: 'svc_error_rollup', filter: {}, groupBy: ['operation', 'code'], fromMs: 0, toMs: DAY, bucketMs: DAY };
    const rows = aggregate([raw('a\u0001b', 'c'), raw('a', 'b\u0001c')], q);
    expect(rows).toHaveLength(2);
    expect(sumBuckets(rows)).toHaveLength(2);
  });

  it('returns no rows (and the caller gap-fills nulls) for an empty store', async () => {
    const { source, calls } = fakeSource([], wmOf({}));
    const reader = new RollupReader(source, { now: () => NOW, lagMs: 10_000 });
    const q: ReadQuery = { kind: 'svc_rollup', filter: { service_id: ['a'] }, groupBy: [], fromMs: NOW - DAY, toMs: NOW, bucketMs: 1800_000 };
    expect(await reader.read(q)).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(reader.slots(q.fromMs, q.toMs, q.bucketMs)).toHaveLength(49);
  });

  it('does not query for a range entirely in the future', async () => {
    const { source, calls } = fakeSource([], wmOf({}));
    const reader = new RollupReader(source, { now: () => NOW, lagMs: 10_000 });
    expect(await reader.read({ kind: 'svc_rollup', filter: {}, groupBy: [], fromMs: NOW + DAY, toMs: NOW + 2 * DAY, bucketMs: HOUR })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('buildSql', () => {
  const q: ReadQuery = {
    kind: 'edge_error_rollup',
    filter: { target_id: ['a', 'a-old'] },
    groupBy: ['operation'],
    fromMs: 0,
    toMs: DAY,
    bucketMs: HOUR,
  };

  it('groups by every id column so aliases can be mapped after the fact', () => {
    expect(groupColumns(q)).toEqual(['operation', 'source_id', 'target_id']);
  });

  it('unions one select per segment, aggregating in SQL when no histogram is needed', () => {
    const segs: Segment[] = [
      { tier: '1h', fromMs: 0, toMs: 20 * HOUR },
      { tier: '1m', fromMs: 20 * HOUR, toMs: DAY },
    ];
    const { text, values } = buildSql(q, segs, groupColumns(q));
    expect(text.split('UNION ALL')).toHaveLength(2);
    expect(text).toContain('FROM edge_error_rollup_1h');
    expect(text).toContain('FROM edge_error_rollup_1m');
    expect(text).toContain('GROUP BY 1, operation, source_id, target_id');
    expect(text).toContain('sample_trace_id');
    expect(text).toContain('AS sample_at');
    expect(values).toEqual([HOUR, ['a', 'a-old'], new Date(0), new Date(20 * HOUR), new Date(20 * HOUR), new Date(DAY)]);
  });

  it('reads raw rows for histograms and rejects a column the kind lacks', () => {
    const red: ReadQuery = { kind: 'svc_rollup', filter: { service_id: ['a'] }, groupBy: [], fromMs: 0, toMs: HOUR, bucketMs: MIN, hist: true };
    const { text } = buildSql(red, [{ tier: '1m', fromMs: 0, toMs: HOUR }], groupColumns(red));
    expect(text).toContain('hist');
    expect(text).not.toContain('GROUP BY');
    expect(() => buildSql({ ...red, filter: { target_id: ['x'] } }, [{ tier: '1m', fromMs: 0, toMs: HOUR }], ['service_id'])).toThrow();
  });
});

describe('aggregate', () => {
  it('floors source buckets into the output bucket', () => {
    const raw: RawRow[] = [0, 10, 50].map((m) => ({ bucketMs: m * MIN, keys: { service_id: 's' }, n: 1, err: 0, sumMs: 1, hist: null, sample: null }));
    const out = aggregate(raw, { kind: 'svc_rollup', filter: {}, groupBy: [], fromMs: 0, toMs: HOUR, bucketMs: 30 * MIN });
    expect(out.map((r) => [r.bucketMs, r.n])).toEqual([
      [0, 2],
      [30 * MIN, 1],
    ]);
  });
});
