import { describe, expect, it } from 'vitest';
import type { LiveAggregate } from '../pipeline/cells.js';
import { addValue, newWideHist } from '../rollup/hist.js';
import { addAggregates, canonicalize, computeLive, scaleHist, statusOf, type LiveMetrics } from './metrics.js';
import { edgeKey } from './structure.js';

function agg(n: number, err: number, ms: number): LiveAggregate {
  const hist = newWideHist();
  for (let i = 0; i < n; i++) addValue(hist, ms);
  return { n, err, sumMs: n * ms, hist };
}

const canon = (id: string) => (id === 'a-old' ? 'a' : id);

describe('canonicalize', () => {
  it('sums two aliases of one service', () => {
    const out = canonicalize(new Map([['a', agg(10, 1, 5)], ['a-old', agg(30, 3, 5)], ['b', agg(1, 0, 5)]]), canon, false);
    expect([...out.keys()].sort()).toEqual(['a', 'b']);
    expect(out.get('a')).toMatchObject({ n: 40, err: 4 });
  });

  it('drops an edge whose ends are now one service and merges parallel edges', () => {
    const out = canonicalize(
      new Map([
        [edgeKey('a', 'a-old'), agg(5, 0, 1)],
        [edgeKey('x', 'a'), agg(2, 0, 1)],
        [edgeKey('x', 'a-old'), agg(3, 1, 1)],
      ]),
      canon,
      true,
    );
    expect([...out.keys()]).toEqual([edgeKey('x', 'a')]);
    expect(out.get(edgeKey('x', 'a'))).toMatchObject({ n: 5, err: 1 });
  });
});

describe('addAggregates', () => {
  it("scales another collector's rows to the local window and leaves them untouched", () => {
    const peer = new Map([['a', agg(300, 30, 10)]]);
    const into = new Map([['a', agg(10, 0, 10)]]);
    // Local window 60 s, peer rows cover 300 s: they contribute 300 / 300 * 60 = 60 spans.
    addAggregates(into, peer, 60 / 300);
    expect(into.get('a')).toMatchObject({ n: 70, err: 6 });
    expect(into.get('a')!.hist.reduce((x, y) => x + y, 0)).toBeCloseTo(70, 9);
    expect(peer.get('a')!.n).toBe(300);
    addAggregates(into, new Map([['b', agg(5, 0, 1)]]));
    expect(into.get('b')!.n).toBe(5);
  });

  it('scales histograms to whole counts that keep the scaled total', () => {
    const h = newWideHist();
    h[10] = 7;
    h[20] = 5;
    h[30] = 1;
    const s = scaleHist(h, 0.3);
    expect(s.every((c) => Number.isInteger(c) && c >= 0)).toBe(true);
    expect(s.reduce((x, y) => x + y, 0)).toBe(Math.round(13 * 0.3));
    expect([s[10], s[20], s[30]]).toEqual([2, 2, 0]);
    // A tiny share of a non-empty histogram keeps one count; an empty one stays empty.
    expect(scaleHist(h, 0.001).reduce((x, y) => x + y, 0)).toBe(1);
    expect(scaleHist(newWideHist(), 0.5).every((c) => c === 0)).toBe(true);
  });
});

describe('computeLive', () => {
  const base = () => ({
    svcSeconds: 100,
    edgeSeconds: 100,
    lastSvc: new Map<string, LiveMetrics>(),
    lastEdge: new Map<string, LiveMetrics>(),
  });

  it('reports own live numbers and remembers them as last known', () => {
    const inp = { ...base(), serviceIds: ['a'], edgeKeys: [], svc: new Map([['a', agg(200, 10, 20)]]), edges: new Map() };
    const out = computeLive(inp);
    expect(out.services.get('a')).toMatchObject({ rps: 2, errPct: 5, stale: false, status: 'crit' });
    expect(out.services.get('a')!.p95).toBeCloseTo(20, -1);
    expect(inp.lastSvc.get('a')).toMatchObject({ rps: 2, stale: true });

    // Next build without traffic: last known, stale.
    const later = computeLive({ ...inp, svc: new Map() });
    expect(later.services.get('a')).toMatchObject({ rps: 2, errPct: 5, stale: true });
  });

  it('gives an external service the aggregate of its live inbound edges', () => {
    const edges = new Map([
      [edgeKey('x', 'db'), agg(100, 0, 2)],
      [edgeKey('y', 'db'), agg(300, 12, 50)],
    ]);
    const out = computeLive({ ...base(), serviceIds: ['db'], edgeKeys: [...edges.keys()], svc: new Map(), edges });
    const db = out.services.get('db')!;
    expect(db).toMatchObject({ rps: 4, errPct: 3, stale: false, status: 'crit' });
    expect(db.p50).toBeCloseTo(50, -1);
    expect(out.edges.get(edgeKey('y', 'db'))).toMatchObject({ rps: 3, errPct: 4, stale: false });
  });

  it('prefers live calls into a silent service over its own stale numbers', () => {
    const inp = {
      ...base(),
      serviceIds: ['svc'],
      edgeKeys: [edgeKey('x', 'svc')],
      svc: new Map(),
      edges: new Map([[edgeKey('x', 'svc'), agg(50, 50, 30_000)]]),
    };
    inp.lastSvc.set('svc', { rps: 9, p50: 1, p95: 2, p99: 3, errPct: 0, stale: true });
    expect(computeLive(inp).services.get('svc')).toMatchObject({ rps: 0.5, errPct: 100, stale: false });
  });

  it('falls back to stale inbound numbers, then to empty', () => {
    const inp = { ...base(), serviceIds: ['db', 'lonely'], edgeKeys: [edgeKey('x', 'db')], svc: new Map(), edges: new Map() };
    inp.lastEdge.set(edgeKey('x', 'db'), { rps: 4, p50: 1, p95: 9, p99: 20, errPct: 50, stale: true });
    inp.lastEdge.set(edgeKey('y', 'db'), { rps: 4, p50: 2, p95: 3, p99: 30, errPct: 0, stale: true });
    const out = computeLive(inp);
    expect(out.services.get('db')).toEqual({ rps: 8, p50: 2, p95: 9, p99: 30, errPct: 25, stale: true, status: 'crit' });
    expect(out.services.get('lonely')).toEqual({ rps: 0, p50: null, p95: null, p99: null, errPct: 0, stale: true, status: 'ok' });
    expect(out.edges.get(edgeKey('x', 'db'))).toMatchObject({ rps: 4, stale: true });
  });
});

describe('statusOf', () => {
  it('uses the existing thresholds', () => {
    expect([statusOf(0), statusOf(0.8), statusOf(0.81), statusOf(2), statusOf(2.1)]).toEqual(['ok', 'ok', 'warn', 'warn', 'crit']);
  });
});
