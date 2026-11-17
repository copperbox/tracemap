/**
 * DB-backed tests for the collector pipeline, rollup writers, compaction and
 * kept traces. They need a TimescaleDB and run only when TEST_DATABASE_URL is
 * set, e.g. postgres://tracemap:tracemap@127.0.0.1:5544/tm_s1. The database
 * is migrated and its new-schema tables are truncated between tests.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import pg from 'pg';
import protobuf from 'protobufjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { decodeTraces } from '../otlp/decode.js';
import { ServiceRegistry } from '../otlp/registry.js';
import { otlpRoutes } from '../otlp/routes.js';
import { compactOnce } from '../rollup/compact.js';
import { addValue, decode, encode, mergeInto, newHist, newWideHist } from '../rollup/hist.js';
import { bigintToSpanHex, hexToUuid } from '../rollup/schema.js';
import { ROLLUP_KINDS, TIERS, tableName } from '../rollup/tiers.js';
import { buildTopology } from '../sim/genTopology.js';
import { exportPayload } from '../sim/payload.js';
import { configureTopology } from '../sim/topology.js';
import { makeTrace, setRoots, type SimSpan } from '../sim/trace.js';
import { Pipeline } from './pipeline.js';

const URL = process.env.TEST_DATABASE_URL;
const PROTO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../otlp/proto');
const HOUR = 3_600_000;

/** Background loops effectively off: tests flush explicitly. */
const quiet = {
  ...config,
  rollupFlushMs: 1e9,
  catalogFlushMs: 1e9,
  compactIntervalMs: 1e9,
  lastStateMs: 1e9,
  heartbeatMs: 1e9,
  edgeResolvedCapacity: 1 << 16,
  traceDecidedCapacity: 1 << 16,
  keptBudgetInitialSpans: 60_000,
};

describe.skipIf(!URL)('pipeline against TimescaleDB', () => {
  let pool: pg.Pool;
  let Req: protobuf.Type;

  beforeAll(async () => {
    await migrate(URL);
    pool = new pg.Pool({ connectionString: URL, max: 6 });
    const root = new protobuf.Root();
    root.resolvePath = (_o, t) => (path.isAbsolute(t) ? t : path.join(PROTO_DIR, t));
    await root.load(['opentelemetry/proto/collector/trace/v1/trace_service.proto']);
    Req = root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest');
    const topo = buildTopology({ services: 300, teams: 0, unassigned: 0, dupRatio: 0 });
    configureTopology(topo);
    setRoots(topo.roots);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    const tables = [
      ...ROLLUP_KINDS.flatMap((k) => TIERS.map((t) => tableName(k.kind, t.name))),
      'rollup_tier_state', 'rollup_dirty_windows', 'collectors', 'service_last_state', 'edge_last_state',
      'kept_spans', 'kept_traces', 'kept_trace_services', 'edges', 'service_aliases', 'services', 'teams',
    ];
    await pool.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
  });

  async function newPipeline(over: Partial<typeof quiet> = {}): Promise<Pipeline> {
    const registry = new ServiceRegistry((text, params) => pool.query(text, params as never[]));
    await registry.load();
    const p = new Pipeline({ ...quiet, ...over }, pool, registry);
    await p.start();
    return p;
  }

  /** OTLP protobuf body for a set of simulated traces. */
  function protoBody(traces: { traceId: string; spans: SimSpan[] }[]): Buffer {
    const resourceSpans: any[] = [];
    for (const t of traces) {
      const p = exportPayload(t.traceId, t.spans) as { resourceSpans: any[] };
      for (const rs of p.resourceSpans) {
        for (const ss of rs.scopeSpans) {
          for (const s of ss.spans) {
            s.traceId = Buffer.from(s.traceId, 'hex');
            s.spanId = Buffer.from(s.spanId, 'hex');
            if (s.parentSpanId) s.parentSpanId = Buffer.from(s.parentSpanId, 'hex');
            else delete s.parentSpanId;
          }
        }
      }
      resourceSpans.push(...p.resourceSpans);
    }
    return Buffer.from(Req.encode(Req.fromObject({ resourceSpans })).finish());
  }

  function makeTraces(minSpans: number): { traceId: string; spans: SimSpan[] }[] {
    const out: { traceId: string; spans: SimSpan[] }[] = [];
    let n = 0;
    while (n < minSpans) {
      const t = makeTrace(Date.now());
      out.push(t);
      n += t.spans.length;
    }
    return out;
  }

  /** Counts computed straight from the generated spans, independent of the pipeline. */
  function expected(traces: { spans: SimSpan[] }[]) {
    const svc = new Map<string, { n: number; err: number }>();
    let edgeN = 0;
    let edgeErr = 0;
    let spans = 0;
    for (const t of traces) {
      for (const s of t.spans) {
        spans++;
        const http = Number(s.attrs['http.response.status_code']);
        const isErr = s.isError || (Number.isFinite(http) && http >= 500);
        if (s.kind === 2 || s.kind === 5 || !s.parentSpanId) {
          const e = svc.get(s.service.id) ?? { n: 0, err: 0 };
          e.n++;
          if (isErr) e.err++;
          svc.set(s.service.id, e);
        }
        if (s.kind === 3 || s.kind === 4) {
          edgeN++;
          if (isErr) edgeErr++;
        }
      }
    }
    return { svc, edgeN, edgeErr, spans };
  }

  async function sums(table: string): Promise<{ n: number; err: number }> {
    const err = table.includes('_error_') ? '0' : 'coalesce(sum(err), 0)::float8';
    const r = await pool.query(`SELECT coalesce(sum(n), 0)::float8 AS n, ${err} AS err FROM ${table}`);
    return { n: r.rows[0].n, err: Number(r.rows[0].err) };
  }

  it('is exact: svc and edge rollups equal counts computed from the sent spans, over large batches', async () => {
    const p = await newPipeline();
    const app = Fastify({ bodyLimit: 32 * 1024 * 1024 });
    await app.register(otlpRoutes, { pipeline: p });
    const sent: { traceId: string; spans: SimSpan[] }[] = [];
    // One export over the old 5,041-span bind-parameter limit, one over 8,192, and some small ones.
    for (const size of [6_000, 20_000, 300, 300, 300]) {
      const traces = makeTraces(size);
      sent.push(...traces);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/traces',
        headers: { 'content-type': 'application/x-protobuf' },
        payload: protoBody(traces),
      });
      expect(res.statusCode).toBe(200);
    }
    await p.flushCatalog();
    await p.flushRollups();
    const want = expected(sent);
    expect(want.spans).toBeGreaterThan(26_000);
    expect(p.stats().spans.accepted).toBe(want.spans);

    const svcRows = await pool.query(
      'SELECT service_id, sum(n)::float8 AS n, sum(err)::float8 AS err FROM svc_rollup_1m GROUP BY 1',
    );
    const got = new Map(svcRows.rows.map((r) => [r.service_id, { n: r.n, err: r.err }]));
    expect(got).toEqual(want.svc);
    expect(await sums('edge_rollup_1m')).toEqual({ n: want.edgeN, err: want.edgeErr });
    expect(await sums('edge_op_rollup_1m')).toEqual({ n: want.edgeN, err: want.edgeErr });
    // op rows partition the svc rows; error rows count every error span.
    const totalN = [...want.svc.values()].reduce((a, b) => a + b.n, 0);
    const totalErr = [...want.svc.values()].reduce((a, b) => a + b.err, 0);
    expect(await sums('op_rollup_1m')).toEqual({ n: totalN, err: totalErr });
    expect((await sums('svc_error_rollup_1m')).n).toBe(totalErr);
    expect((await sums('edge_error_rollup_1m')).n).toBe(want.edgeErr);

    // Rewriting the same cells on the next flush does not double count.
    p.cells.restoreDirty(p.cells.takeDirty());
    await p.flushRollups();
    expect((await sums('svc_rollup_1m')).n).toBe(totalN);

    const svcCount = await pool.query('SELECT count(*)::int AS n FROM services');
    expect(svcCount.rows[0].n).toBeGreaterThan(0);
    const edgeCount = await pool.query('SELECT count(*)::int AS n, sum(sample_count)::float8 AS s FROM edges');
    expect(edgeCount.rows[0].s).toBe(want.edgeN);
    await app.close();
    await p.shutdown();
  }, 60_000);

  it('answers 400 for a malformed payload and 429 when overloaded', async () => {
    const p = await newPipeline({ overloadMaxInflight: -1 });
    const app = Fastify({ bodyLimit: 32 * 1024 * 1024 });
    await app.register(otlpRoutes, { pipeline: p });
    const busy = await app.inject({ method: 'POST', url: '/v1/traces', headers: { 'content-type': 'application/x-protobuf' }, payload: Buffer.from([1]) });
    expect(busy.statusCode).toBe(429);
    expect(busy.headers['retry-after']).toBeDefined();
    await app.close();
    await p.shutdown();

    const q = await newPipeline();
    const app2 = Fastify();
    await app2.register(otlpRoutes, { pipeline: q });
    const bad = await app2.inject({ method: 'POST', url: '/v1/traces', headers: { 'content-type': 'application/x-protobuf' }, payload: Buffer.from([0x0a, 0xff, 0xff]) });
    expect(bad.statusCode).toBe(400);
    const badJson = await app2.inject({ method: 'POST', url: '/v1/traces', headers: { 'content-type': 'application/json' }, payload: '{nope' });
    expect(badJson.statusCode).toBe(400);
    const metrics = await app2.inject({
      method: 'POST',
      url: '/v1/metrics',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'metrics-only' } }] }, scopeMetrics: [{ metrics: [{ name: 'up', gauge: { dataPoints: [{ asDouble: 1, timeUnixNano: '1' }] } }] }] }] }),
    });
    expect(metrics.statusCode).toBe(200);
    await q.flushCatalog();
    const svc = await pool.query("SELECT id FROM services WHERE id = 'metrics-only'");
    expect(svc.rowCount).toBe(1);
    await app2.close();
    await q.shutdown();
  });

  it('round-trips a kept trace: ids survive the uuid/bigint mapping and the sample is recorded', async () => {
    const p = await newPipeline();
    const traceId = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';
    const ids = { root: 'ffffffffffffffff', call: '8000000000000001', handled: '0000000000000001' };
    const now = BigInt(Date.now()) * 1_000_000n;
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'gw' } }] },
          scopeSpans: [{ spans: [
            { traceId, spanId: ids.root, name: 'GET /', kind: 2, startTimeUnixNano: String(now), endTimeUnixNano: String(now + 30_000_000n), status: { code: 2 }, attributes: [{ key: 'http.response.status_code', value: { intValue: '503' } }] },
            { traceId, spanId: ids.call, parentSpanId: ids.root, name: 'call orders', kind: 3, startTimeUnixNano: String(now + 1_000_000n), endTimeUnixNano: String(now + 20_000_000n), attributes: [] },
          ] }],
        },
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'orders' } }] },
          scopeSpans: [{ spans: [
            { traceId, spanId: ids.handled, parentSpanId: ids.call, name: 'GET /orders', kind: 2, startTimeUnixNano: String(now + 2_000_000n), endTimeUnixNano: String(now + 19_000_000n), status: { code: 2 }, attributes: [{ key: 'exception.type', value: { stringValue: 'Timeout' } }] },
          ] }],
        },
      ],
    };
    p.ingestTraces(await decodeTraces(Buffer.from(JSON.stringify(body)), 'application/json'));
    p.traces.decideAll();
    await p.flushKept();
    await p.flushRollups();

    const spans = await pool.query(
      'SELECT span_id::text, parent_span_id::text, service_id, peer_service_id, is_root, is_error, http_status FROM kept_spans WHERE trace_id = $1',
      [hexToUuid(traceId)],
    );
    const byId = new Map(spans.rows.map((r) => [bigintToSpanHex(r.span_id), r]));
    expect([...byId.keys()].sort()).toEqual(Object.values(ids).sort());
    expect(bigintToSpanHex(byId.get(ids.call)!.parent_span_id)).toBe(ids.root);
    expect(bigintToSpanHex(byId.get(ids.handled)!.parent_span_id)).toBe(ids.call);
    expect(byId.get(ids.root)).toMatchObject({ is_root: true, is_error: true, http_status: 503, parent_span_id: null });
    expect(byId.get(ids.call)!.peer_service_id).toBe('orders');

    const kt = await pool.query('SELECT reason, span_count, root_service, has_error FROM kept_traces WHERE trace_id = $1', [hexToUuid(traceId)]);
    expect(kt.rows).toEqual([{ reason: 'error', span_count: 3, root_service: 'gw', has_error: true }]);
    const kts = await pool.query('SELECT service_id, has_error, error_ops FROM kept_trace_services WHERE trace_id = $1 ORDER BY 1', [hexToUuid(traceId)]);
    expect(kts.rows).toEqual([
      { service_id: 'gw', has_error: true, error_ops: ['GET /'] },
      { service_id: 'orders', has_error: true, error_ops: ['GET /orders'] },
    ]);
    const sample = await pool.query("SELECT sample_trace_id FROM svc_error_rollup_1m WHERE service_id = 'gw'");
    expect(sample.rows[0].sample_trace_id).toBe(hexToUuid(traceId));
    await p.shutdown();
  });

  it('compacts tiers exactly and idempotently', async () => {
    // Synthetic 1m rows from two collectors over two hours, ending well before now.
    const end = Math.floor((Date.now() - 6 * HOUR) / HOUR) * HOUR;
    const start = end - 2 * HOUR;
    const rows = { bucket: [] as string[], coll: [] as number[], svc: [] as string[], n: [] as number[], err: [] as number[], sum: [] as number[], hist: [] as Buffer[] };
    const errRows = { bucket: [] as string[], coll: [] as number[], n: [] as number[], sample: [] as (string | null)[] };
    for (let t = start; t < end; t += 60_000) {
      for (const coll of [1, 2]) {
        for (const svc of ['a', 'b']) {
          const h = newHist();
          const k = 1 + ((t / 60_000 + coll) % 7);
          for (let i = 0; i < k; i++) addValue(h, (i + 1) * 3.7 * coll);
          rows.bucket.push(new Date(t).toISOString());
          rows.coll.push(coll);
          rows.svc.push(svc);
          rows.n.push(k);
          rows.err.push(k % 2);
          rows.sum.push(k * 10);
          rows.hist.push(encode(h));
        }
        errRows.bucket.push(new Date(t).toISOString());
        errRows.coll.push(coll);
        errRows.n.push(2);
        errRows.sample.push((t / 60_000) % 13 === 0 ? hexToUuid((t / 60_000).toString(16).padStart(32, '0')) : null);
      }
    }
    await pool.query(
      `INSERT INTO svc_rollup_1m SELECT * FROM unnest($1::timestamptz[], $2::int[], $3::text[], $4::bigint[], $5::bigint[], $6::float8[], $7::bytea[])`,
      [rows.bucket, rows.coll, rows.svc, rows.n, rows.err, rows.sum, rows.hist],
    );
    await pool.query(
      `INSERT INTO svc_error_rollup_1m (bucket, collector_id, service_id, operation, code, message, n, sample_trace_id)
       SELECT b, c, 'a', 'GET', 'E', '', n, s FROM unnest($1::timestamptz[], $2::int[], $3::bigint[], $4::uuid[]) AS u(b, c, n, s)`,
      [errRows.bucket, errRows.coll, errRows.n, errRows.sample],
    );

    const opts = { graceMinutes: 3, flushMs: 10_000, maxWindowsPerRun: { '10m': 1000, '1h': 1000, '1d': 1000 }, chunkRows: 100 };
    const first = await compactOnce(pool, opts);
    expect(first.ran).toBe(true);

    // Each 10m row equals the merge of its 1m rows across both collectors.
    const src = await pool.query('SELECT bucket, service_id, n, err, sum_ms, hist FROM svc_rollup_1m');
    const want = new Map<string, { n: number; err: number; sum: number; hist: Float64Array }>();
    for (const r of src.rows) {
      const b = Math.floor(r.bucket.getTime() / 600_000) * 600_000;
      const k = `${b}/${r.service_id}`;
      const w = want.get(k) ?? { n: 0, err: 0, sum: 0, hist: newWideHist() };
      w.n += Number(r.n);
      w.err += Number(r.err);
      w.sum += r.sum_ms;
      mergeInto(w.hist, decode(r.hist));
      want.set(k, w);
    }
    const got10 = await pool.query('SELECT bucket, service_id, n, err, sum_ms, hist FROM svc_rollup_10m');
    expect(got10.rowCount).toBe(want.size);
    for (const r of got10.rows) {
      const w = want.get(`${r.bucket.getTime()}/${r.service_id}`)!;
      expect([Number(r.n), Number(r.err), r.sum_ms]).toEqual([w.n, w.err, w.sum]);
      expect([...decode(r.hist)]).toEqual([...w.hist]);
    }
    // 1h equals the sum of its 10m rows, and totals are preserved through every tier.
    for (const t of ['10m', '1h']) {
      const s = await pool.query(`SELECT sum(n)::float8 AS n, sum(err)::float8 AS err FROM svc_rollup_${t}`);
      expect(s.rows[0]).toEqual({ n: rows.n.reduce((a, b) => a + b, 0), err: rows.err.reduce((a, b) => a + b, 0) });
    }
    const hourRows = await pool.query('SELECT count(*)::int AS n FROM svc_rollup_1h');
    expect(hourRows.rows[0].n).toBe(4); // two hours x two services
    const errHour = await pool.query('SELECT sum(n)::int AS n, count(sample_trace_id)::int AS s FROM svc_error_rollup_1h');
    expect(errHour.rows[0].n).toBe(errRows.n.reduce((a, b) => a + b, 0));
    expect(errHour.rows[0].s).toBeGreaterThan(0);

    // Re-running, even from rewound watermarks, changes nothing.
    const snapshot = async () =>
      (await pool.query(
        `SELECT '10m' AS t, bucket, service_id, n, err, sum_ms, encode(hist, 'hex') AS h FROM svc_rollup_10m
         UNION ALL SELECT '1h', bucket, service_id, n, err, sum_ms, encode(hist, 'hex') FROM svc_rollup_1h
         UNION ALL SELECT 'e1h', bucket, service_id, n, 0, 0, sample_trace_id::text FROM svc_error_rollup_1h
         ORDER BY 1, 2, 3`,
      )).rows;
    const before = await snapshot();
    const again = await compactOnce(pool, opts);
    expect(again.windows).toBe(0);
    await pool.query('UPDATE rollup_tier_state SET compacted_through = $1', [new Date(start)]);
    const rerun = await compactOnce(pool, opts);
    expect(rerun.windows).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(before);

    // A second process cannot run compaction while the lock is held.
    const holder = await pool.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [0x544d_4331]);
    expect((await compactOnce(pool, opts)).ran).toBe(false);
    await holder.query('SELECT pg_advisory_unlock($1)', [0x544d_4331]);
    holder.release();
  }, 60_000);

  it('catches up after downtime in bounded steps', async () => {
    const t0 = Math.floor((Date.now() - 30 * HOUR) / 600_000) * 600_000;
    await pool.query(
      `INSERT INTO svc_rollup_1m VALUES ($1, 1, 'a', 1, 0, 1, ''::bytea), ($2, 1, 'a', 1, 0, 1, ''::bytea)`,
      [new Date(t0), new Date(t0 + 20 * HOUR)],
    );
    const opts = { graceMinutes: 3, flushMs: 10_000, maxWindowsPerRun: { '10m': 36, '1h': 24, '1d': 7 }, chunkRows: 1000 };
    const r1 = await compactOnce(pool, opts);
    expect(r1.windows).toBeLessThanOrEqual(36 + 24 + 7);
    const wm = await pool.query("SELECT compacted_through FROM rollup_tier_state WHERE kind = 'svc_rollup' AND tier = '10m'");
    expect(wm.rows[0].compacted_through.getTime()).toBe(t0 + 6 * HOUR);
    let runs = 1;
    while ((await compactOnce(pool, opts)).windows > 0 && runs < 50) runs++;
    const total = await pool.query('SELECT sum(n)::int AS n FROM svc_rollup_10m');
    expect(total.rows[0].n).toBe(2);
    expect(runs).toBeGreaterThan(3);
  }, 60_000);

  /** JSON OTLP body: `n` SERVER spans of `service` starting at `atMs`, every third one an error. */
  function serverSpans(service: string, n: number, atMs: number, seed: number) {
    const start = BigInt(atMs) * 1_000_000n;
    const spans = [];
    for (let i = 0; i < n; i++) {
      spans.push({
        traceId: (seed * 100_000 + i + 1).toString(16).padStart(32, '0'),
        spanId: (seed * 100_000 + i + 1).toString(16).padStart(16, '0'),
        name: i % 2 ? 'GET /a' : 'GET /b',
        kind: 2,
        startTimeUnixNano: String(start + BigInt(i) * 1000n),
        endTimeUnixNano: String(start + BigInt(i) * 1000n + 5_000_000n),
        status: { code: i % 3 === 0 ? 2 : 0 },
      });
    }
    return Buffer.from(JSON.stringify({
      resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] }, scopeSpans: [{ spans }] }],
    }));
  }

  it('repairs coarse tiers when a flush lands after compaction passed its window', async () => {
    const p = await newPipeline();
    const base = Math.floor((Date.now() - 10 * 60_000) / 60_000) * 60_000 + 7_000;
    p.ingestTraces(await decodeTraces(serverSpans('late-svc', 30, base, 1), 'application/json'), base);
    await p.flushRollups(base);
    // The database becomes unreachable: these spans stay in memory, unflushed.
    p.ingestTraces(await decodeTraces(serverSpans('late-svc', 12, base + 1_000, 2), 'application/json'), base + 1_000);

    // Compaction runs as if two days passed, so 10m, 1h and 1d all move past the window.
    const later = base + 2 * 24 * HOUR;
    const opts = { graceMinutes: 3, flushMs: 10_000, maxWindowsPerRun: { '10m': 1000, '1h': 1000, '1d': 1000 }, chunkRows: 1000 };
    await compactOnce(pool, opts, later);
    const wm = await pool.query("SELECT tier, compacted_through FROM rollup_tier_state WHERE kind = 'svc_rollup'");
    for (const r of wm.rows) expect(r.compacted_through.getTime()).toBeGreaterThan(base);
    const total = async (kind: string, t: string) => {
      const err = kind.includes('_error_') ? '0' : 'coalesce(sum(err), 0)::float8';
      return (await pool.query(`SELECT coalesce(sum(n), 0)::float8 AS n, ${err} AS err FROM ${kind}_${t}`)).rows[0];
    };
    expect((await total('svc_rollup', '1d')).n).toBe(30);

    // The collector recovers and flushes the late rows.
    await p.flushRollups(base + 2_000);
    const dirty = await pool.query("SELECT kind, tier FROM rollup_dirty_windows WHERE tier = '10m' ORDER BY kind");
    expect(dirty.rows.map((r) => r.kind)).toEqual(['op_rollup', 'svc_error_rollup', 'svc_rollup']);

    const r = await compactOnce(pool, opts, later);
    expect(r.repaired).toBe(9); // three kinds x (10m, 1h, 1d)
    for (const kind of ['svc_rollup', 'op_rollup', 'svc_error_rollup']) {
      const want = await total(kind, '1m');
      expect(want.n).toBe(kind === 'svc_error_rollup' ? 14 : 42);
      for (const t of ['10m', '1h', '1d']) expect(await total(kind, t)).toEqual(want);
    }
    expect((await total('svc_rollup', '1d')).err).toBe(14);
    expect((await pool.query('SELECT count(*)::int AS n FROM rollup_dirty_windows')).rows[0].n).toBe(0);
    // Nothing left to repair, and re-running changes nothing.
    expect((await compactOnce(pool, opts, later)).repaired).toBe(0);
    expect(await total('svc_rollup', '1d')).toEqual(await total('svc_rollup', '1m'));
    await p.shutdown();
  }, 120_000);

  it('counts late spans of a kept trace into kept_traces.span_count', async () => {
    const p = await newPipeline();
    const traceId = 'abcdef0123456789abcdef0123456789';
    const now = BigInt(Date.now()) * 1_000_000n;
    const body = (spanId: string, parent: string | null) => Buffer.from(JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'gw' } }] },
        scopeSpans: [{ spans: [{
          traceId, spanId, ...(parent ? { parentSpanId: parent } : {}), name: 'GET /', kind: parent ? 1 : 2,
          startTimeUnixNano: String(now), endTimeUnixNano: String(now + 1_000_000n),
        }] }],
      }],
    }));
    const ingest = async (spanId: string, parent: string | null) =>
      p.ingestTraces(await decodeTraces(body(spanId, parent), 'application/json'));
    const count = async () =>
      (await pool.query('SELECT span_count FROM kept_traces WHERE trace_id = $1', [hexToUuid(traceId)])).rows[0]?.span_count;
    const spans = async () =>
      (await pool.query('SELECT count(*)::int AS n FROM kept_spans WHERE trace_id = $1', [hexToUuid(traceId)])).rows[0].n;

    await ingest('0000000000000001', null);
    p.traces.decideAll();
    // Late while the trace is still queued: it joins the trace.
    await ingest('0000000000000002', '0000000000000001');
    await p.flushKept();
    expect([await count(), await spans()]).toEqual([2, 2]);
    // Late after the trace was written: span_count is updated with the spans.
    await ingest('0000000000000003', '0000000000000001');
    await ingest('0000000000000004', '0000000000000001');
    await p.flushKept();
    expect([await count(), await spans()]).toEqual([4, 4]);
    await p.shutdown();
  });

  it('writes last state and heartbeats', async () => {
    const p = await newPipeline();
    p.ingestTraces(await decodeTraces(protoBody(makeTraces(500)), 'application/x-protobuf'));
    await p.writeLastState();
    await p.heartbeat();
    const s = await pool.query('SELECT count(*)::int AS n, min(rps) AS rps FROM service_last_state');
    expect(s.rows[0].n).toBe(p.liveServices().entries.size);
    expect(s.rows[0].rps).toBeGreaterThan(0);
    const e = await pool.query('SELECT count(*)::int AS n FROM edge_last_state');
    expect(e.rows[0].n).toBe(p.liveEdges().entries.size);
    const c = await pool.query('SELECT id, heartbeat_at > started_at AS beat FROM collectors');
    expect(c.rows).toEqual([{ id: p.collectorId, beat: true }]);
    await p.shutdown();
  });
});
