import { describe, expect, it } from 'vitest';
import { EdgeResolver } from './edgeResolver.js';

const client = (over: Partial<Parameters<EdgeResolver['onClientSpan']>[0]> = {}) => ({
  spanId: 'c1',
  serviceId: 'a',
  operation: 'GET /x',
  timeMs: 1000,
  durationMs: 12,
  isError: false,
  peerGuess: null,
  ...over,
});

describe('EdgeResolver', () => {
  it('emits immediately when the peer is attribute-inferred', () => {
    const r = new EdgeResolver();
    const obs = r.onClientSpan(
      client({ peerGuess: { id: 'pg-orders', type: 'postgres', isExternal: true } }),
    );
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ sourceId: 'a', targetId: 'pg-orders', durationMs: 12 });
  });

  it('joins client -> later server span (client arrives first)', () => {
    const r = new EdgeResolver();
    expect(r.onClientSpan(client())).toHaveLength(0);
    const obs = r.onServerSpan('c1', 'b');
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ sourceId: 'a', targetId: 'b', operation: 'GET /x' });
  });

  it('joins server -> later client span (server batch arrives first)', () => {
    const r = new EdgeResolver();
    expect(r.onServerSpan('c1', 'b')).toHaveLength(0);
    const obs = r.onClientSpan(client());
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ sourceId: 'a', targetId: 'b' });
  });

  it('prefers the real server span over an attribute guess when both exist', () => {
    const r = new EdgeResolver();
    r.onServerSpan('c1', 'b');
    const obs = r.onClientSpan(
      client({ peerGuess: { id: 'b-alias', type: 'service', isExternal: false } }),
    );
    expect(obs).toHaveLength(1);
    expect(obs[0].targetId).toBe('b');
  });

  it('does not double-emit when the server span arrives after an inferred emit', () => {
    const r = new EdgeResolver();
    const first = r.onClientSpan(
      client({ peerGuess: { id: 'b', type: 'service', isExternal: false } }),
    );
    expect(first).toHaveLength(1);
    expect(r.onServerSpan('c1', 'b')).toHaveLength(0);
  });

  it('ignores same-service parent/child pairs', () => {
    const r = new EdgeResolver();
    r.onClientSpan(client({ serviceId: 'a' }));
    expect(r.onServerSpan('c1', 'a')).toHaveLength(0);
  });

  it('expires unmatched spans after the TTL', () => {
    const r = new EdgeResolver(1000);
    const t0 = 1_000_000;
    r.onClientSpan(client(), t0);
    r.onServerSpan('zz', 'b', t0);
    expect(r.pendingCount).toBe(2);
    r.flush(t0 + 2000);
    expect(r.pendingCount).toBe(0);
  });
});
