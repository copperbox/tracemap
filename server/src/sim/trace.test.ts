import { describe, expect, it } from 'vitest';
import { clientAttrsFor, makeTrace, pickRoot, ROOTS } from './trace.js';
import { byId } from './topology.js';

describe('clientAttrsFor', () => {
  it('emits db semantic conventions for postgres', () => {
    expect(clientAttrsFor(byId.get('pg-orders')!, 'SELECT orders')).toEqual({
      'db.system': 'postgresql',
      'db.statement': 'SELECT orders WHERE ...',
      'server.address': 'pg-orders.internal',
      'server.port': 5432,
    });
  });

  it('emits db semantic conventions for redis', () => {
    expect(clientAttrsFor(byId.get('redis-cart')!, 'GET cart:{uid}')).toEqual({
      'db.system': 'redis',
      'db.statement': 'GET cart:{uid}',
      'server.address': 'redis-cart.internal',
      'server.port': 6379,
    });
  });

  it('emits messaging conventions for kafka', () => {
    expect(clientAttrsFor(byId.get('kafka-events')!, 'checkout.completed')).toEqual({
      'messaging.system': 'kafka',
      'messaging.destination.name': 'checkout.completed',
      'messaging.operation': 'publish',
      'server.address': 'kafka-events.internal',
    });
  });

  it('emits rpc conventions for s3', () => {
    expect(clientAttrsFor(byId.get('s3-media')!, 'GetObject')).toEqual({
      'rpc.system': 'aws-api',
      'rpc.service': 'S3',
      'rpc.method': 'GetObject',
      'aws.s3.bucket': 'media-prod',
    });
  });

  it('emits https url attributes for external SaaS hosts', () => {
    expect(clientAttrsFor(byId.get('api.stripe.com')!, 'POST /v1/refunds')).toEqual({
      'http.request.method': 'POST',
      'url.full': 'https://api.stripe.com/v1/refunds',
      'server.address': 'api.stripe.com',
    });
  });

  it('emits internal http attributes for instrumented services', () => {
    expect(clientAttrsFor(byId.get('orders-svc')!, 'GET /v1/orders')).toEqual({
      'http.request.method': 'GET',
      'url.full': 'http://orders-svc.internal:8080/v1/orders',
      'server.address': 'orders-svc.internal',
      'server.port': 8080,
    });
  });

  it('defaults the method to POST when the op has no verb', () => {
    const attrs = clientAttrsFor(byId.get('orders-svc')!, 'reprocess');
    expect(attrs['http.request.method']).toBe('POST');
    expect(attrs['url.full']).toBe('http://orders-svc.internal:8080/reprocess');
  });
});

describe('pickRoot', () => {
  it('always returns one of the configured entry points', () => {
    const ids = new Set(ROOTS.map(([id]) => id));
    for (let i = 0; i < 200; i++) {
      expect(ids.has(pickRoot())).toBe(true);
    }
  });
});

describe('makeTrace', () => {
  it('produces a 32-char hex trace id', () => {
    expect(makeTrace().traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces exactly one root SERVER span', () => {
    const { spans } = makeTrace();
    const roots = spans.filter((s) => s.parentSpanId === null);
    expect(roots).toHaveLength(1);
    expect(roots[0].kind).toBe(2);
    expect(new Set(ROOTS.map(([id]) => id)).has(roots[0].service.id)).toBe(true);
  });

  it('produces well-formed spans: hex ids and non-negative durations', () => {
    const { spans } = makeTrace();
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(s.endNs >= s.startNs).toBe(true);
      expect([2, 3, 4]).toContain(s.kind);
    }
  });

  it('starts the trace shortly before the requested timestamp', () => {
    const atMs = 1_700_000_000_000;
    const { spans } = makeTrace(atMs);
    const root = spans.find((s) => s.parentSpanId === null)!;
    const atNs = BigInt(atMs) * 1_000_000n;
    // Root start is jittered 5-60ms before `atMs`.
    expect(root.startNs < atNs).toBe(true);
    expect(atNs - root.startNs <= 60n * 1_000_000n).toBe(true);
  });
});
