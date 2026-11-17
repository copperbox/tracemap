import { gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { GateResult, Pipeline } from '../pipeline/index.js';
import { otlpRoutes } from './routes.js';

vi.mock('../pipeline/index.js', () => ({ getPipeline: () => null }));

const EXPORT = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'orders' } }] },
      scopeSpans: [{ spans: [{ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'GET /', kind: 2, startTimeUnixNano: '1', endTimeUnixNano: '2' }] }],
    },
  ],
};

function fakePipeline(over: { gate?: GateResult; ingest?: () => void } = {}) {
  const counts: Record<string, number> = {};
  const seen: string[] = [];
  const p = {
    inflight: 0,
    gate: () => over.gate ?? { ok: true },
    countRequest: (k: string) => (counts[k] = (counts[k] ?? 0) + 1),
    ingestTraces: vi.fn(over.ingest ?? (() => ({ spans: 1, edgeObservations: 0 }))),
    noteMetricServices: (names: Iterable<string>) => seen.push(...names),
  };
  return { p: p as unknown as Pipeline, raw: p, counts, seen };
}

async function app(p: Pipeline) {
  const a = Fastify();
  await a.register(otlpRoutes, { pipeline: p });
  return a;
}

describe('OTLP routes', () => {
  it('accepts JSON and gzip-compressed JSON', async () => {
    const f = fakePipeline();
    const a = await app(f.p);
    const plain = await a.inject({ method: 'POST', url: '/v1/traces', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(EXPORT) });
    expect(plain.statusCode).toBe(200);
    const gz = await a.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: gzipSync(JSON.stringify(EXPORT)),
    });
    expect(gz.statusCode).toBe(200);
    expect(f.raw.ingestTraces).toHaveBeenCalledTimes(2);
    expect(f.raw.ingestTraces.mock.calls[1][0][0].serviceName).toBe('orders');
    expect(f.raw.inflight).toBe(0);
  });

  it('answers 400 for undecodable payloads only', async () => {
    const f = fakePipeline();
    const a = await app(f.p);
    for (const [headers, payload] of [
      [{ 'content-type': 'application/json' }, '{nope'],
      [{ 'content-type': 'application/x-protobuf' }, Buffer.from([0x0a, 0xff, 0xff])],
      [{ 'content-type': 'application/json', 'content-encoding': 'gzip' }, 'not gzip'],
      [{ 'content-type': 'application/json', 'content-encoding': 'br' }, '{}'],
    ] as const) {
      const r = await a.inject({ method: 'POST', url: '/v1/traces', headers, payload });
      expect(r.statusCode).toBe(400);
    }
    expect(f.counts.malformed).toBe(4);
    expect(f.raw.ingestTraces).not.toHaveBeenCalled();
  });

  it('answers 429 with Retry-After when the gate is closed', async () => {
    const f = fakePipeline({ gate: { ok: false, reason: 'event-loop-lag', retryAfterSec: 3 } });
    const a = await app(f.p);
    const r = await a.inject({ method: 'POST', url: '/v1/traces', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(EXPORT) });
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('3');
    expect(f.raw.ingestTraces).not.toHaveBeenCalled();
  });

  it('answers 503, never 400, when the pipeline itself fails', async () => {
    const f = fakePipeline({ ingest: () => { throw new Error('boom'); } });
    const a = await app(f.p);
    const r = await a.inject({ method: 'POST', url: '/v1/traces', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(EXPORT) });
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBeDefined();
    expect(f.counts.failed).toBe(1);
  });

  it('registers services from /v1/metrics without storing points', async () => {
    const f = fakePipeline();
    const a = await app(f.p);
    const r = await a.inject({
      method: 'POST',
      url: '/v1/metrics',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        resourceMetrics: [{
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'billing' } }] },
          scopeMetrics: [{ metrics: [{ name: 'up', gauge: { dataPoints: [{ asDouble: 1, timeUnixNano: '1' }] } }] }],
        }],
      }),
    });
    expect(r.statusCode).toBe(200);
    expect(f.seen).toEqual(['billing']);
  });
});
