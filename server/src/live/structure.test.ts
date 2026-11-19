import { describe, expect, it } from 'vitest';
import { StructureTracker, stableOrder, type Catalog, type CatalogService } from './structure.js';

const T0 = Date.UTC(2026, 10, 17, 12);
/** A tracker whose process started a second before T0, so T0 may publish. */
const tracker = (refreshMs = 60_000) => new StructureTracker(refreshMs, T0 - 1000);

function svc(id: string, over: Partial<CatalogService> = {}): CatalogService {
  return {
    id,
    name: id,
    description: null,
    type: 'service',
    teamId: null,
    runtime: null,
    region: null,
    isExternal: false,
    sloTarget: 99.9,
    firstSeen: '2026-11-01T00:00:00.000Z',
    lastSeen: '2026-11-17T12:00:00.000Z',
    ...over,
  };
}

function catalog(ids: string[], edges: [string, string][] = [], over: Partial<Catalog> = {}): Catalog {
  return {
    services: ids.map((id) => svc(id)),
    edges: edges.map(([source, target]) => ({
      source,
      target,
      firstSeen: '2026-11-01T00:00:00.000Z',
      lastSeen: '2026-11-17T12:00:00.000Z',
      samples: 100,
      manual: false,
    })),
    teams: [],
    ...over,
  };
}

const noSlo = () => null;

describe('stableOrder', () => {
  it('keeps survivors in place and appends new keys sorted', () => {
    expect(stableOrder(['c', 'a', 'b'], ['b', 'z', 'c', 'd'])).toEqual(['c', 'b', 'd', 'z']);
    expect(stableOrder([], ['b', 'a'])).toEqual(['a', 'b']);
  });
});

describe('StructureTracker', () => {
  it('versions by publish second and indexes edges into services', () => {
    const tr = tracker();
    const u = tr.update(catalog(['b', 'a'], [['a', 'b']]), noSlo, T0 + 400);
    expect(u.changed).toBe(true);
    expect(u.structure!.version).toBe(T0 / 1000);
    expect(u.structure!.services.map((s) => s.id)).toEqual(['a', 'b']);
    expect(u.structure!.edges).toEqual([expect.objectContaining({ s: 0, t: 1, samples: 100, confidence: 90.1 })]);
  });

  it('publishes nothing in the second the process started', () => {
    const tr = new StructureTracker(60_000, T0 + 300);
    expect(tr.nextPublishAtMs).toBe(T0 + 1000);
    const early = tr.update(catalog(['a']), noSlo, T0 + 900);
    expect(early).toEqual({ structure: null, changed: false });
    expect(tr.pending).toBe(true);
    const u = tr.update(catalog(['a']), noSlo, T0 + 1000);
    expect(u.structure!.version).toBe(T0 / 1000 + 1);
    expect(tr.pending).toBe(false);
  });

  it('publishes at most one version per second and never runs ahead of the clock', () => {
    const tr = tracker();
    const v1 = tr.update(catalog(['a']), noSlo, T0).structure!;
    // A change in the same second waits; the old structure stays current.
    const same = tr.update(catalog(['a', 'b']), noSlo, T0 + 999);
    expect(same.changed).toBe(false);
    expect(same.structure).toBe(v1);
    expect(tr.pending).toBe(true);
    // The next update after the second turns publishes it.
    const v2 = tr.update(catalog(['a', 'b']), noSlo, T0 + 1000).structure!;
    expect(v2.version).toBe(v1.version + 1);
    expect(v2.services.map((s) => s.id)).toEqual(['a', 'b']);
    // After a quiet spell the version jumps to the clock, not previous + 1.
    const v3 = tr.update(catalog(['a', 'b', 'c']), noSlo, T0 + 30_500).structure!;
    expect(v3.version).toBe(T0 / 1000 + 30);
  });

  it('never reuses a version across a quick restart', () => {
    // Process A bumps three times within a few seconds, then restarts.
    const a = tracker();
    const seen = new Set<number>();
    let t = T0;
    for (const ids of [['a'], ['a', 'b'], ['a', 'b', 'c']]) {
      seen.add(a.update(catalog(ids), noSlo, t).structure!.version);
      t += 1000;
    }
    const lastA = Math.max(...seen);
    // Process B starts in the very second A published its last version.
    const restartAt = lastA * 1000 + 200;
    const b = new StructureTracker(60_000, restartAt);
    expect(b.update(catalog(['x']), noSlo, restartAt + 100).structure).toBeNull();
    const first = b.update(catalog(['x']), noSlo, b.nextPublishAtMs).structure!;
    expect(first.version).toBeGreaterThan(lastA);
  });

  it('does not bump the version when nothing changed', () => {
    const tr = tracker();
    const first = tr.update(catalog(['a', 'b']), noSlo, T0);
    const again = tr.update(catalog(['a', 'b']), noSlo, T0 + 120_000);
    expect(again.changed).toBe(false);
    expect(again.structure).toBe(first.structure);
  });

  it('bumps immediately on a structural change and keeps existing indexes', () => {
    const tr = tracker();
    const v1 = tr.update(catalog(['m', 'c', 'x']), noSlo, T0).structure!;
    expect(v1.services.map((s) => s.id)).toEqual(['c', 'm', 'x']);
    const v2 = tr.update(catalog(['m', 'c', 'x', 'a']), noSlo, T0 + 1000);
    expect(v2.changed).toBe(true);
    expect(v2.structure!.version).toBe(v1.version + 1);
    // New service appended, not sorted in.
    expect(v2.structure!.services.map((s) => s.id)).toEqual(['c', 'm', 'x', 'a']);
    // A removal compacts but keeps relative order.
    const v3 = tr.update(catalog(['x', 'a', 'c']), noSlo, T0 + 2000);
    expect(v3.structure!.services.map((s) => s.id)).toEqual(['c', 'x', 'a']);
  });

  it('treats metadata, team and edge changes as structural', () => {
    const tr = tracker();
    const base = catalog(['a', 'b'], [['a', 'b']]);
    tr.update(base, noSlo, T0);
    const renamed = { ...base, services: [svc('a', { name: 'Alpha' }), svc('b')] };
    expect(tr.update(renamed, noSlo, T0 + 1000).changed).toBe(true);
    const withTeam = { ...renamed, teams: [{ id: 1, name: 'core' }] };
    expect(tr.update(withTeam, noSlo, T0 + 2000).changed).toBe(true);
    const manual = { ...withTeam, edges: [{ ...withTeam.edges[0], manual: true }] };
    expect(tr.update(manual, noSlo, T0 + 3000).changed).toBe(true);
    const noEdges = { ...manual, edges: [] };
    expect(tr.update(noEdges, noSlo, T0 + 4000).structure!.edges).toEqual([]);
  });

  it('refreshes volatile fields at most once per interval', () => {
    const tr = tracker();
    const base = catalog(['a', 'b'], [['a', 'b']]);
    const v1 = tr.update(base, noSlo, T0).structure!;
    const busier = (n: number, at: string) => ({
      ...base,
      services: [svc('a', { lastSeen: at }), svc('b')],
      edges: [{ ...base.edges[0], samples: n, lastSeen: at }],
    });
    const early = tr.update(busier(500, '2026-11-17T12:00:30.000Z'), () => 99.5, T0 + 30_000);
    expect(early.changed).toBe(false);
    expect(early.structure!.edges[0].samples).toBe(100);
    const due = tr.update(busier(900, '2026-11-17T12:01:00.000Z'), () => 99.5, T0 + 60_000);
    expect(due.changed).toBe(true);
    expect(due.structure!.version).toBe(v1.version + 60);
    expect(due.structure!.edges[0]).toMatchObject({ samples: 900, confidence: 92.4 });
    expect(due.structure!.services[0]).toMatchObject({ lastSeen: '2026-11-17T12:01:00.000Z', sloAttain: 99.5 });
    // Same volatile values later: still no bump.
    expect(tr.update(busier(900, '2026-11-17T12:01:00.000Z'), () => 99.5, T0 + 200_000).changed).toBe(false);
  });

  it('publishes volatile fields right away after expireVolatile()', () => {
    const tr = tracker();
    tr.update(catalog(['a']), noSlo, T0);
    expect(tr.update(catalog(['a']), () => 99.9, T0 + 2000).changed).toBe(false);
    tr.expireVolatile();
    const u = tr.update(catalog(['a']), () => 99.9, T0 + 4000);
    expect(u.changed).toBe(true);
    expect(u.structure!.services[0].sloAttain).toBe(99.9);
  });

  it('drops self-edges and edges to unknown services', () => {
    const tr = tracker();
    const s = tr.update(catalog(['a', 'b'], [['a', 'a'], ['a', 'gone'], ['b', 'a']]), noSlo, T0).structure!;
    expect(s.edges.map((e) => [e.s, e.t])).toEqual([[1, 0]]);
  });
});
