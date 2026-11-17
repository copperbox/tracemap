/**
 * DB-backed tests for the read path: known traces go through the real
 * pipeline into the rollup and kept-trace tables, then every endpoint the UI
 * uses is checked against counts computed by hand, including after a merge and
 * an unmerge. Runs only when TEST_DATABASE_URL is set, e.g.
 * postgres://tracemap:tracemap@127.0.0.1:5544/tm_s2.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE_URL = process.env.TEST_DATABASE_URL;
/**
 * A sibling database (<name>_api), so this file can run in parallel with the
 * pipeline tests, which truncate the same tables in TEST_DATABASE_URL.
 */
const URL = BASE_URL ? BASE_URL.replace(/\/([^/?]+)(\?|$)/, '/$1_api$2') : undefined;
if (URL) process.env.DATABASE_URL = URL;

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!URL)('API read path against TimescaleDB', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let mods: {
    pipeline: import('../pipeline/pipeline.js').Pipeline;
    live: import('../live/index.js').Live;
    decodeFrame: typeof import('../live/frame.js').decodeFrame;
    closePools: () => Promise<void>;
  };
  const SPAN_MS = Date.now() - 100_000;
  const sentTraceIds: { a: string[]; b: string[] } = { a: [], b: [] };

  // ---- hand-built traces ----
  let spanSeq = 1;
  const spanId = () => (spanSeq++).toString(16).padStart(16, '0');
  const ns = (ms: number) => String(BigInt(Math.round(ms * 1000)) * 1000n);
  const attr = (key: string, v: string | number) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } });

  interface S {
    service: string;
    traceId: string;
    spanId: string;
    parent?: string;
    name: string;
    kind: number;
    at: number;
    dur: number;
    error?: boolean;
    attrs?: { key: string; value: unknown }[];
  }

  function body(spans: S[]): Buffer {
    const by = new Map<string, S[]>();
    for (const s of spans) by.set(s.service, [...(by.get(s.service) ?? []), s]);
    return Buffer.from(
      JSON.stringify({
        resourceSpans: [...by].map(([service, list]) => ({
          resource: { attributes: [attr('service.name', service)] },
          scopeSpans: [
            {
              spans: list.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                ...(s.parent ? { parentSpanId: s.parent } : {}),
                name: s.name,
                kind: s.kind,
                startTimeUnixNano: ns(s.at),
                endTimeUnixNano: ns(s.at + s.dur),
                ...(s.error ? { status: { code: 2 } } : {}),
                attributes: s.attrs ?? [],
              })),
            },
          ],
        })),
      }),
    );
  }

  /** gw -> orders -> pg-main; errors fail in orders (Timeout) and its db call (PgError). */
  function traceA(i: number, err: boolean): S[] {
    const traceId = (0xa0000 + i).toString(16).padStart(32, '0');
    sentTraceIds.a.push(traceId);
    const at = SPAN_MS + i * 10;
    const root = spanId();
    const call = spanId();
    const handled = spanId();
    const db = spanId();
    return [
      { service: 'gw', traceId, spanId: root, name: 'GET /', kind: 2, at, dur: 40 },
      { service: 'gw', traceId, spanId: call, parent: root, name: 'call orders', kind: 3, at: at + 1, dur: 30 },
      { service: 'orders', traceId, spanId: handled, parent: call, name: 'GET /orders', kind: 2, at: at + 2, dur: 25, error: err, attrs: err ? [attr('exception.type', 'Timeout')] : [] },
      { service: 'orders', traceId, spanId: db, parent: handled, name: 'SELECT', kind: 3, at: at + 3, dur: 5, error: err, attrs: [attr('db.system', 'postgresql'), attr('server.address', 'pg-main'), ...(err ? [attr('exception.type', 'PgError')] : [])] },
    ];
  }

  /** gw -> dup-orders -> (pg-main, orders); dup-orders fails with HTTP 503. */
  function traceB(i: number, err: boolean): S[] {
    const traceId = (0xb0000 + i).toString(16).padStart(32, '0');
    sentTraceIds.b.push(traceId);
    const at = SPAN_MS + 500 + i * 10;
    const root = spanId();
    const call = spanId();
    const handled = spanId();
    const db = spanId();
    const proxy = spanId();
    const inner = spanId();
    return [
      { service: 'gw', traceId, spanId: root, name: 'GET /b', kind: 2, at, dur: 50 },
      { service: 'gw', traceId, spanId: call, parent: root, name: 'call dup', kind: 3, at: at + 1, dur: 40 },
      { service: 'dup-orders', traceId, spanId: handled, parent: call, name: 'GET /orders', kind: 2, at: at + 2, dur: 35, error: err, attrs: err ? [attr('http.response.status_code', 503)] : [] },
      { service: 'dup-orders', traceId, spanId: db, parent: handled, name: 'SELECT', kind: 3, at: at + 3, dur: 4, error: err, attrs: [attr('db.system', 'postgresql'), attr('server.address', 'pg-main'), ...(err ? [attr('exception.type', 'PgError')] : [])] },
      { service: 'dup-orders', traceId, spanId: proxy, parent: handled, name: 'proxy', kind: 3, at: at + 8, dur: 20 },
      { service: 'orders', traceId, spanId: inner, parent: proxy, name: 'GET /orders', kind: 2, at: at + 9, dur: 15 },
    ];
  }

  async function get(url: string): Promise<{ status: number; json: Json; headers: Record<string, unknown>; raw: Buffer }> {
    const res = await app.inject({ method: 'GET', url });
    const raw = res.rawPayload;
    let json: Json = null;
    try {
      json = JSON.parse(raw.toString());
    } catch {
      /* binary */
    }
    return { status: res.statusCode, json, headers: res.headers, raw };
  }

  async function topo(): Promise<{ svc: Map<string, Json>; edges: Map<string, Json> }> {
    await mods.live.snapshot.refreshNow();
    const t = (await get('/api/topology')).json;
    return {
      svc: new Map(t.services.map((s: Json) => [s.id, s])),
      edges: new Map(t.edges.map((e: Json) => [`${e.source}>${e.target}`, e])),
    };
  }

  /** Spans counted in an hourly point: the hour holding now is rated over its elapsed part (minus half a flush). */
  const hourCount = (p: Json) => {
    const start = Date.parse(p.t);
    const secs = Math.min(3600, (Date.now() - 5_000 - start) / 1000);
    return p.rps * secs;
  };

  const range = () => {
    const now = Date.now();
    return `from=${new Date(now - 3_600_000).toISOString()}&to=${new Date(now).toISOString()}`;
  };

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    const name = new globalThis.URL(URL!).pathname.slice(1);
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();
    const { migrate } = await import('../db/migrate.js');
    await migrate(URL);
    pool = new pg.Pool({ connectionString: URL, max: 4 });
    const { ROLLUP_KINDS, TIERS, tableName } = await import('../rollup/tiers.js');
    const tables = [
      ...ROLLUP_KINDS.flatMap((k) => TIERS.map((t) => tableName(k.kind, t.name))),
      'rollup_tier_state', 'collectors', 'service_last_state', 'edge_last_state', 'service_merges',
      'kept_spans', 'kept_traces', 'kept_trace_services', 'edges', 'service_aliases', 'services', 'teams',
    ];
    await pool.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);

    const { config } = await import('../config.js');
    // Background loops off: the test flushes explicitly.
    Object.assign(config, {
      rollupFlushMs: 1e9,
      catalogFlushMs: 1e9,
      compactIntervalMs: 1e9,
      lastStateMs: 1e9,
      heartbeatMs: 1e9,
      edgeResolvedCapacity: 1 << 16,
      traceDecidedCapacity: 1 << 16,
      keptBudgetInitialSpans: 60_000,
    });
    const { registry } = await import('../otlp/registry.js');
    await registry.load();
    const { getPipeline } = await import('../pipeline/index.js');
    const pipeline = getPipeline();
    await pipeline.start();
    // The reader's right-edge lag is one real flush interval.
    config.rollupFlushMs = 10_000;
    const { getLive } = await import('../live/index.js');
    const live = getLive();
    const Fastify = (await import('fastify')).default;
    const { apiRoutes } = await import('./routes.js');
    app = Fastify();
    await app.register(apiRoutes, { prefix: '/api' });
    const { decodeFrame } = await import('../live/frame.js');
    const { closePools } = await import('../db/pool.js');
    mods = { pipeline, live, decodeFrame, closePools };

    const { decodeTraces } = await import('../otlp/decode.js');
    const spans: S[] = [];
    for (let i = 0; i < 12; i++) spans.push(...traceA(i, i % 3 === 0));
    for (let i = 0; i < 6; i++) spans.push(...traceB(i, i % 3 === 0));
    // Services first, so the catalog knows them before peers are inferred.
    pipeline.ingestTraces(await decodeTraces(body(spans), 'application/json'));
    pipeline.traces.decideAll();
    await pipeline.flushKept();
    await pipeline.flushCatalog();
    await pipeline.flushRollups();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await mods?.live.snapshot.stop();
    await mods?.pipeline.shutdown();
    await mods?.closePools();
    await pool?.end();
  });

  it('wrote what the hand count says (sanity check of the fixture)', async () => {
    const r = await pool.query('SELECT service_id, sum(n)::int AS n, sum(err)::int AS err FROM svc_rollup_1m GROUP BY 1 ORDER BY 1');
    expect(r.rows).toEqual([
      { service_id: 'dup-orders', n: 6, err: 2 },
      { service_id: 'gw', n: 18, err: 0 },
      { service_id: 'orders', n: 18, err: 4 },
    ]);
  });

  it('serves topology, structure and frame from one snapshot with the same numbers', async () => {
    const { svc, edges } = await topo();
    expect([...svc.keys()].sort()).toEqual(['dup-orders', 'gw', 'orders', 'pg-main']);
    const gw = svc.get('gw').metrics;
    expect(gw.stale).toBe(false);
    expect(svc.get('orders').metrics.rps / gw.rps).toBeCloseTo(1, 9);
    expect(svc.get('dup-orders').metrics.rps / gw.rps).toBeCloseTo(6 / 18, 9);
    expect(svc.get('orders').metrics.errPct).toBeCloseTo((4 / 18) * 100, 9);
    expect(svc.get('orders').status).toBe('crit');
    // External: node metrics from the calls into it (12 + 6 calls, 4 + 2 errors).
    const pgm = svc.get('pg-main');
    expect(pgm.isExternal).toBe(true);
    expect(pgm.metrics.rps / gw.rps).toBeCloseTo(1, 9);
    expect(pgm.metrics.errPct).toBeCloseTo((6 / 18) * 100, 9);
    expect([...edges.keys()].sort()).toEqual(['dup-orders>orders', 'dup-orders>pg-main', 'gw>dup-orders', 'gw>orders', 'orders>pg-main']);
    expect(edges.get('gw>orders').metrics.rps / gw.rps).toBeCloseTo(12 / 18, 9);

    const structure = await get('/api/live/structure');
    expect(structure.headers.etag).toBe(`"${structure.json.version}"`);
    const frameRes = await app.inject({ method: 'GET', url: '/api/live/metrics', headers: { 'accept-encoding': 'identity' } });
    expect(frameRes.headers['content-type']).toBe('application/octet-stream');
    const frame = mods.decodeFrame(frameRes.rawPayload);
    expect(frame.structureVersion).toBe(structure.json.version);
    expect(frame.services).toHaveLength(structure.json.services.length);
    expect(frame.edges).toHaveLength(structure.json.edges.length);
    const i = structure.json.services.findIndex((s: Json) => s.id === 'orders');
    expect(frame.services[i].errPct).toBeCloseTo((4 / 18) * 100, 4);
    expect(frame.services[i].status).toBe('crit');
    const e = structure.json.edges.findIndex(
      (x: Json) => structure.json.services[x.s].id === 'gw' && structure.json.services[x.t].id === 'orders',
    );
    expect(frame.edges[e].stale).toBe(false);

    // Conditional and compressed requests.
    const again = await app.inject({ method: 'GET', url: '/api/live/structure', headers: { 'if-none-match': structure.headers.etag as string } });
    expect(again.statusCode).toBe(304);
    const gz = await app.inject({ method: 'GET', url: '/api/topology', headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers['content-encoding']).toBe('gzip');
  });

  it('lists services from the snapshot', async () => {
    const list = (await get('/api/services')).json;
    expect(list.edgeCount).toBe(5);
    const orders = list.services.find((s: Json) => s.id === 'orders');
    expect(orders.errPct).toBeCloseTo((4 / 18) * 100, 9);
    expect(orders.spark.length).toBeGreaterThan(0);
  });

  it('serves a service page from the rollups with exact counts', async () => {
    const d = (await get(`/api/services/orders?${range()}`)).json;
    expect(d.range.bucketSeconds).toBe(60);
    const minute = new Date(Math.floor(SPAN_MS / 60_000) * 60_000).toISOString();
    const pt = d.series.find((p: Json) => p.t === minute);
    expect(pt.rps * 60).toBeCloseTo(18, 6);
    expect(pt.errPct).toBeCloseTo((4 / 18) * 100, 9);
    expect(pt.p95).toBeGreaterThan(10);
    expect(d.series.filter((p: Json) => p.rps != null)).toHaveLength(1);
    expect(d.kpis.errPct).toBeCloseTo((4 / 18) * 100, 9);
    expect(d.operations).toEqual([expect.objectContaining({ name: 'GET /orders', errPct: (4 / 18) * 100 })]);
    expect(d.neighbors.map((n: Json) => `${n.source}>${n.target}`).sort()).toEqual(['dup-orders>orders', 'gw>orders', 'orders>pg-main']);
    expect(d.aliases).toEqual([]);

    const ext = (await get(`/api/services/pg-main?${range()}`)).json;
    expect(ext.series.find((p: Json) => p.t === minute).rps * 60).toBeCloseTo(18, 6);
    expect(ext.operations).toEqual([expect.objectContaining({ name: 'SELECT', errPct: (6 / 18) * 100 })]);

    const day = (await get('/api/services/orders')).json;
    expect(day.range.bucketSeconds).toBe(1800);
    expect(day.series.length).toBeGreaterThanOrEqual(48);
  });

  it('serves sparklines and edge series', async () => {
    const sp = (await get('/api/services/orders/sparklines')).json;
    expect(sp.points.length).toBeGreaterThanOrEqual(24);
    const hour = sp.points.find((p: Json) => p.rps != null);
    expect(hourCount(hour)).toBeCloseTo(18, 1);
    const es = (await get('/api/edges/gw/orders/series')).json;
    expect(es.operations).toEqual([{ name: 'call orders', share: 1 }]);
    expect(es.points.find((p: Json) => p.rps != null).errPct).toBe(0);
  });

  it('aggregates errors from the rollups, with sample traces that resolve', async () => {
    const svcErr = (await get(`/api/services/orders/errors?${range()}`)).json;
    expect(svcErr.operations).toHaveLength(1);
    expect(svcErr.operations[0]).toMatchObject({ operation: 'GET /orders', errorCount: 4 });
    expect(svcErr.operations[0].errors[0]).toMatchObject({ code: 'Timeout', message: null, count: 4 });
    const sample = svcErr.operations[0].errors[0].sampleTraceId;
    expect(sentTraceIds.a).toContain(sample);

    const trace = await get(`/api/traces/${sample}`);
    expect(trace.status).toBe(200);
    expect(trace.json.spanCount).toBe(4);
    expect(trace.json.reason).toBe('error');
    const root = trace.json.spans.find((s: Json) => s.parentSpanId == null);
    expect(root).toMatchObject({ serviceId: 'gw', name: 'GET /' });
    expect(trace.json.spans.every((s: Json) => /^[0-9a-f]{16}$/.test(s.spanId))).toBe(true);
    expect((await get(`/api/traces/${'f'.repeat(32)}`)).status).toBe(404);
    expect((await get('/api/traces/not-a-trace')).status).toBe(404);

    const ext = (await get(`/api/services/pg-main/errors?${range()}`)).json;
    expect(ext.operations[0]).toMatchObject({ operation: 'SELECT', errorCount: 6 });
    const edge = (await get(`/api/edges/dup-orders/pg-main/errors?${range()}`)).json;
    expect(edge.operations[0]).toMatchObject({ operation: 'SELECT', errorCount: 2 });
  });

  it('lists kept traces for a service with the reason they were kept', async () => {
    const list = (await get(`/api/services/orders/traces?${range()}`)).json.traces;
    expect(list.length).toBeGreaterThan(0);
    for (const t of list) {
      expect(t.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(['error', 'slow', 'baseline']).toContain(t.reason);
    }
    expect(list.some((t: Json) => t.reason === 'error' && t.status === 'error')).toBe(true);
    const onlyErr = (await get(`/api/services/orders/traces?${range()}&op=${encodeURIComponent('GET /orders')}`)).json.traces;
    expect(onlyErr.every((t: Json) => t.status === 'error')).toBe(true);
  });

  it('merges at read time in milliseconds and unmerges back exactly', async () => {
    const before = await topo();
    const gwRps = before.svc.get('gw').metrics.rps;

    const t0 = performance.now();
    const m = await app.inject({ method: 'POST', url: '/api/services/orders/merge', payload: { sourceId: 'dup-orders' } });
    const mergeMs = performance.now() - t0;
    expect(m.statusCode).toBe(200);
    expect(mergeMs).toBeLessThan(1000);
    // No telemetry was rewritten.
    const raw = await pool.query("SELECT count(*)::int AS n FROM svc_rollup_1m WHERE service_id = 'dup-orders'");
    expect(raw.rows[0].n).toBeGreaterThan(0);

    const after = await topo();
    expect(after.svc.has('dup-orders')).toBe(false);
    const orders = after.svc.get('orders').metrics;
    // Two aliases of one service sum: 18 + 6 handled, 4 + 2 errors.
    expect(orders.rps / after.svc.get('gw').metrics.rps).toBeCloseTo(24 / 18, 9);
    expect(orders.errPct).toBeCloseTo((6 / 24) * 100, 9);
    // dup-orders -> orders became a self-edge and is gone; gw's two edges are one.
    expect([...after.edges.keys()].sort()).toEqual(['gw>orders', 'orders>pg-main']);
    expect(after.edges.get('gw>orders').metrics.rps / gwRps).toBeCloseTo(1, 9);
    expect(after.edges.get('orders>pg-main').metrics.rps / gwRps).toBeCloseTo(1, 9);

    const d = (await get(`/api/services/orders?${range()}`)).json;
    expect(d.aliases).toEqual(['dup-orders']);
    const minute = new Date(Math.floor(SPAN_MS / 60_000) * 60_000).toISOString();
    expect(d.series.find((p: Json) => p.t === minute).rps * 60).toBeCloseTo(24, 6);
    const errs = (await get(`/api/services/orders/errors?${range()}`)).json;
    expect(errs.operations[0].errorCount).toBe(6);
    expect(errs.operations[0].errors.map((e: Json) => [e.code, e.count])).toEqual([
      ['Timeout', 4],
      ['HTTP 503', 2],
    ]);
    const es = (await get('/api/edges/gw/orders/series')).json;
    expect(hourCount(es.points.find((p: Json) => p.rps != null))).toBeCloseTo(18, 1);
    const traces = (await get(`/api/services/orders/traces?${range()}`)).json.traces;
    expect(traces.some((t: Json) => sentTraceIds.b.includes(t.traceId))).toBe(true);
    const bTrace = (await get(`/api/traces/${traces.find((t: Json) => sentTraceIds.b.includes(t.traceId)).traceId}`)).json;
    expect(bTrace.spans.some((s: Json) => s.serviceId === 'dup-orders')).toBe(false);
    // A merged id has no service row any more.
    expect((await get(`/api/services/dup-orders?${range()}`)).status).toBe(404);

    const t1 = performance.now();
    const u = await app.inject({ method: 'POST', url: '/api/services/orders/unmerge', payload: { sourceId: 'dup-orders' } });
    expect(u.statusCode).toBe(200);
    expect(performance.now() - t1).toBeLessThan(1000);

    const back = await topo();
    expect([...back.svc.keys()].sort()).toEqual(['dup-orders', 'gw', 'orders', 'pg-main']);
    expect(back.svc.get('orders').metrics.rps / back.svc.get('gw').metrics.rps).toBeCloseTo(1, 9);
    expect(back.svc.get('dup-orders').metrics.rps / back.svc.get('gw').metrics.rps).toBeCloseTo(6 / 18, 9);
    expect(back.edges.has('dup-orders>orders')).toBe(true);
    const d2 = (await get(`/api/services/orders?${range()}`)).json;
    expect(d2.aliases).toEqual([]);
    expect(d2.series.find((p: Json) => p.t === minute).rps * 60).toBeCloseTo(18, 6);
    const dup = (await get(`/api/services/dup-orders/errors?${range()}`)).json;
    expect(dup.operations[0].errors[0]).toMatchObject({ code: 'HTTP 503', count: 2 });
  });

  it('reports health with the pipeline and live stats', async () => {
    const h = (await get('/api/health')).json;
    expect(h).toMatchObject({ ok: true, services: 4 });
    expect(typeof h.spansLastMinute).toBe('number');
    expect(typeof h.pendingEdgeResolutions).toBe('number');
    expect(h.pipeline.collectorId).toBe(mods.pipeline.collectorId);
    expect(h.live.seq).toBeGreaterThan(0);
  });
});
