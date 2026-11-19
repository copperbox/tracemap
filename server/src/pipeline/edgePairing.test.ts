import { describe, expect, it } from 'vitest';
import { EdgePairing, type ClientSpanInfo } from './edgePairing.js';

const opts = { ttlMs: 30_000, maxPending: 1000, resolvedCapacity: 1024 };

const client = (over: Partial<ClientSpanInfo> = {}): ClientSpanInfo => ({
  spanId: 'c100000000000001',
  serviceId: 'a',
  operation: 'GET /x',
  timeMs: 1000,
  durationMs: 12,
  isError: false,
  peerGuess: null,
  ...over,
});

describe('EdgePairing', () => {
  it('emits immediately when the peer is attribute-inferred, and holds nothing', () => {
    const r = new EdgePairing(opts, 0);
    const ob = r.onClientSpan(client({ peerGuess: { id: 'pg-orders', type: 'postgres', isExternal: true } }), 0);
    expect(ob).toMatchObject({ sourceId: 'a', targetId: 'pg-orders', durationMs: 12 });
    expect(r.pendingCount).toBe(0);
  });

  it('joins client -> later server span (client arrives first)', () => {
    const r = new EdgePairing(opts, 0);
    expect(r.onClientSpan(client(), 0)).toBeNull();
    expect(r.pendingCount).toBe(1);
    expect(r.onServerSpan('c100000000000001', 'b', 0)).toMatchObject({
      sourceId: 'a',
      targetId: 'b',
      operation: 'GET /x',
    });
    expect(r.pendingCount).toBe(0);
  });

  it('joins server -> later client span (server batch arrives first)', () => {
    const r = new EdgePairing(opts, 0);
    expect(r.onServerSpan('c100000000000001', 'b', 0)).toBeNull();
    expect(r.onClientSpan(client(), 0)).toMatchObject({ sourceId: 'a', targetId: 'b' });
    expect(r.pendingCount).toBe(0);
  });

  it('prefers the real server span over an attribute guess when both exist', () => {
    const r = new EdgePairing(opts, 0);
    r.onServerSpan('c100000000000001', 'b', 0);
    const ob = r.onClientSpan(client({ peerGuess: { id: 'b-alias', type: 'service', isExternal: false } }), 0);
    expect(ob?.targetId).toBe('b');
  });

  it('a late server span for a guess-resolved client neither waits nor double counts', () => {
    const r = new EdgePairing(opts, 0);
    expect(r.onClientSpan(client({ peerGuess: { id: 'b', type: 'service', isExternal: false } }), 0)).not.toBeNull();
    expect(r.onServerSpan('c100000000000001', 'b', 5)).toBeNull();
    expect(r.pendingCount).toBe(0);
    expect(r.stats().lateServers).toBe(1);
  });

  it('ignores same-service parent/child pairs', () => {
    const r = new EdgePairing(opts, 0);
    r.onClientSpan(client({ serviceId: 'a' }), 0);
    expect(r.onServerSpan('c100000000000001', 'a', 0)).toBeNull();
  });

  it('carries the error signature through to the observation', () => {
    const r = new EdgePairing(opts, 0);
    r.onClientSpan(client({ isError: true, errCode: 'HTTP 503', errMessage: 'down' }), 0);
    expect(r.onServerSpan('c100000000000001', 'b', 0)).toMatchObject({ isError: true, errCode: 'HTTP 503' });
  });

  it('expires unmatched spans after the TTL', () => {
    const r = new EdgePairing({ ...opts, ttlMs: 1000 }, 0);
    r.onClientSpan(client(), 0);
    r.onServerSpan('ffff000000000000', 'b', 0);
    expect(r.pendingCount).toBe(2);
    r.sweep(500);
    expect(r.pendingCount).toBe(2);
    r.sweep(2000);
    expect(r.pendingCount).toBe(0);
    expect(r.stats().expired).toBe(2);
  });

  it('caps held entries, evicting the oldest first', () => {
    const r = new EdgePairing({ ...opts, maxPending: 3 }, 0);
    for (let i = 0; i < 5; i++) r.onClientSpan(client({ spanId: `000000000000000${i}` }), i);
    expect(r.pendingCount).toBe(3);
    expect(r.stats().evicted).toBe(2);
    // The two oldest are gone; the newest still pairs.
    expect(r.onServerSpan('0000000000000000', 'b', 10)).toBeNull();
    expect(r.onServerSpan('0000000000000004', 'b', 10)).not.toBeNull();
  });

  it('does not count a replayed guess-resolved client span twice', () => {
    const r = new EdgePairing(opts, 0);
    const c = client({ peerGuess: { id: 'pg', type: 'postgres', isExternal: true } });
    expect(r.onClientSpan(c, 0)).not.toBeNull();
    expect(r.onClientSpan(c, 100)).toBeNull();
    expect(r.pendingCount).toBe(0);
    expect(r.stats()).toMatchObject({ resolvedByGuess: 1, replayedClients: 1 });
  });

  it('does not count a replayed client/server pair twice (client first)', () => {
    const r = new EdgePairing(opts, 0);
    r.onClientSpan(client(), 0);
    expect(r.onServerSpan('c100000000000001', 'b', 0)).not.toBeNull();
    // The whole batch again: neither half is held or counted.
    expect(r.onClientSpan(client(), 100)).toBeNull();
    expect(r.onServerSpan('c100000000000001', 'b', 100)).toBeNull();
    expect(r.pendingCount).toBe(0);
    expect(r.stats()).toMatchObject({ resolvedByServer: 1, replayedClients: 1, lateServers: 1 });
  });

  it('does not count a replayed client/server pair twice (server first)', () => {
    const r = new EdgePairing(opts, 0);
    r.onServerSpan('c100000000000001', 'b', 0);
    expect(r.onClientSpan(client(), 0)).not.toBeNull();
    expect(r.onServerSpan('c100000000000001', 'b', 100)).toBeNull();
    expect(r.onClientSpan(client(), 100)).toBeNull();
    expect(r.pendingCount).toBe(0);
    expect(r.stats().resolvedByServer).toBe(1);
  });

  it('keeps the original arrival time of a duplicate held span, so it still expires and evicts first', () => {
    const r = new EdgePairing({ ...opts, ttlMs: 1000, maxPending: 3 }, 0);
    r.onClientSpan(client({ spanId: '0000000000000001' }), 0);
    r.onServerSpan('ffff000000000001', 'b', 0);
    r.onClientSpan(client({ spanId: '0000000000000002' }), 900);
    // Duplicates of the oldest entries arrive late.
    r.onClientSpan(client({ spanId: '0000000000000001' }), 950);
    r.onServerSpan('ffff000000000001', 'b', 950);
    expect(r.pendingCount).toBe(3);
    r.sweep(1500);
    // Both originals (t=0) expired; the t=900 entry did not block the sweep.
    expect(r.pendingCount).toBe(1);
    expect(r.stats().expired).toBe(2);

    const e = new EdgePairing({ ...opts, maxPending: 2 }, 0);
    e.onClientSpan(client({ spanId: '0000000000000001' }), 0);
    e.onClientSpan(client({ spanId: '0000000000000002' }), 1);
    e.onClientSpan(client({ spanId: '0000000000000001' }), 2);
    e.onClientSpan(client({ spanId: '0000000000000003' }), 3);
    // Oldest-first: 0001 (first seen at 0) is the one evicted.
    expect(e.onServerSpan('0000000000000002', 'b', 4)).not.toBeNull();
    expect(e.onServerSpan('0000000000000001', 'b', 4)).toBeNull();
  });
});
