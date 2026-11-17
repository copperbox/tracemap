import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { Topology, TopologyEdge, TopologyService } from '../api/types';
import { buildGraph, groupKey } from './grouping';

const svc = (id: string, teamId: number | null, over: Partial<TopologyService> = {}): TopologyService => ({
  id,
  name: id,
  description: null,
  type: 'service',
  teamId,
  runtime: null,
  region: null,
  isExternal: false,
  sloTarget: 99.9,
  sloAttain: 99.95,
  firstSeen: '2026-06-01T00:00:00Z',
  lastSeen: '2026-06-11T00:00:00Z',
  status: 'ok',
  metrics: { rps: 100, p50: 10, p95: 50, p99: 90, errPct: 0.1, stale: false },
  ...over,
});

const edge = (source: string, target: string, over: Partial<TopologyEdge> = {}): TopologyEdge => ({
  source,
  target,
  firstSeen: '2026-06-01T00:00:00Z',
  lastSeen: '2026-06-11T00:00:00Z',
  samples: 1000,
  manual: false,
  confidence: 99,
  status: 'ok',
  metrics: { rps: 10, p50: 5, p95: 20, p99: 40, errPct: 0.2, stale: false },
  ...over,
});

const topo = (services: TopologyService[], edges: TopologyEdge[]): Topology => ({
  services,
  edges,
  teams: [
    { id: 1, name: 'Checkout' },
    { id: 2, name: 'Catalog' },
  ],
  generatedAt: '2026-06-11T00:00:00Z',
});

describe('buildGraph', () => {
  const services = [
    svc('checkout-svc', 1),
    svc('orders-svc', 1, { status: 'crit', metrics: { rps: 50, p50: 10, p95: 200, p99: 400, errPct: 4, stale: false } }),
    svc('catalog-svc', 2),
    svc('api.stripe.com', null, { isExternal: true, type: 'external' }),
  ];
  const edges = [
    edge('checkout-svc', 'orders-svc'),
    edge('checkout-svc', 'catalog-svc'),
    edge('checkout-svc', 'api.stripe.com', { metrics: { rps: 5, p50: 100, p95: 400, p99: 800, errPct: 1, stale: false } }),
    edge('orders-svc', 'catalog-svc', { metrics: { rps: 20, p50: 5, p95: 30, p99: 60, errPct: 0.5, stale: false } }),
  ];

  it('passes services through untouched when no teams are merged', () => {
    const g = buildGraph(topo(services, edges), { mergedTeams: [] });
    expect(g.nodes.map((n) => n.key).sort()).toEqual(
      ['api.stripe.com', 'catalog-svc', 'checkout-svc', 'orders-svc'].sort(),
    );
    expect(g.edges).toHaveLength(4);
  });

  it('collapses merged teams into meganodes and drops intra-group edges', () => {
    const g = buildGraph(topo(services, edges), { mergedTeams: [1, 2] });
    const keys = g.nodes.map((n) => n.key).sort();
    expect(keys).toEqual([groupKey(1), groupKey(2), 'api.stripe.com'].sort());
    // checkout-svc -> orders-svc is internal to team 1 and disappears
    expect(g.edges.map((e) => e.key).sort()).toEqual(
      [`${groupKey(1)}=>${groupKey(2)}`, `${groupKey(1)}=>api.stripe.com`].sort(),
    );
  });

  it('aggregates edges crossing a group boundary', () => {
    const g = buildGraph(topo(services, edges), { mergedTeams: [1, 2] });
    const agg = g.edges.find((e) => e.key === `${groupKey(1)}=>${groupKey(2)}`);
    expect(agg).toBeDefined();
    expect(agg?.underlying).toHaveLength(2); // checkout->catalog + orders->catalog
    expect(agg?.rps).toBeCloseTo(30);
    expect(agg?.p95).toBe(30);
  });

  it('meganode carries worst status and weighted error rate', () => {
    const g = buildGraph(topo(services, edges), { mergedTeams: [1, 2] });
    const mega = g.nodes.find((n) => n.key === groupKey(1));
    expect(mega?.status).toBe('crit');
    expect(mega?.rps).toBeCloseTo(150);
    // (0.1% * 100rps + 4% * 50rps) / 150rps
    expect(mega?.errPct).toBeCloseTo((0.001 * 100 + 0.04 * 50) / 150 * 100, 5);
    expect(mega?.memberIds.sort()).toEqual(['checkout-svc', 'orders-svc']);
  });

  it('passes edge staleness through when no teams are merged', () => {
    const stale = edges.map((e) =>
      e.target === 'api.stripe.com' ? { ...e, metrics: { ...e.metrics, stale: true } } : e,
    );
    const g = buildGraph(topo(services, stale), { mergedTeams: [] });
    expect(g.edges.find((e) => e.targetKey === 'api.stripe.com')?.stale).toBe(true);
    expect(g.edges.find((e) => e.targetKey === 'catalog-svc')?.stale).toBe(false);
  });

  it('aggregated edge is stale only when every underlying edge is stale', () => {
    const markStale = (e: TopologyEdge, ids: string[]): TopologyEdge =>
      ids.includes(e.source) ? { ...e, metrics: { ...e.metrics, stale: true } } : e;

    // one of the two team1 -> team2 edges stale: still live
    const partial = edges.map((e) => markStale(e, ['orders-svc']));
    const g1 = buildGraph(topo(services, partial), { mergedTeams: [1, 2] });
    expect(g1.edges.find((e) => e.key === `${groupKey(1)}=>${groupKey(2)}`)?.stale).toBe(false);

    // both stale: aggregate goes stale
    const full = edges.map((e) => markStale(e, ['orders-svc', 'checkout-svc']));
    const g2 = buildGraph(topo(services, full), { mergedTeams: [1, 2] });
    expect(g2.edges.find((e) => e.key === `${groupKey(1)}=>${groupKey(2)}`)?.stale).toBe(true);
  });

  it('unmerging a team restores its individual services', () => {
    const g = buildGraph(topo(services, edges), { mergedTeams: [2] });
    const keys = g.nodes.map((n) => n.key);
    expect(keys).toContain('checkout-svc');
    expect(keys).toContain('orders-svc');
    expect(keys).toContain(groupKey(2));
    expect(keys).not.toContain(groupKey(1));
    // checkout->orders edge is visible again
    expect(g.edges.some((e) => e.key === 'checkout-svc=>orders-svc')).toBe(true);
  });

  it('ungrouped (teamless) external services always stay individual', () => {
    const g = buildGraph(topo(services, edges), { mergedTeams: [1, 2] });
    expect(g.nodes.some((n) => n.key === 'api.stripe.com' && n.kind === 'service')).toBe(true);
  });

  it('tags each service node with its owning team name', () => {
    const g = buildGraph(topo(services, edges), { mergedTeams: [] });
    expect(g.nodes.find((n) => n.key === 'checkout-svc')?.teamName).toBe('Checkout');
    expect(g.nodes.find((n) => n.key === 'catalog-svc')?.teamName).toBe('Catalog');
    // teamless external has no team name
    expect(g.nodes.find((n) => n.key === 'api.stripe.com')?.teamName).toBeNull();
  });

  it('keeps every team individual when team grouping is disabled', () => {
    const g = buildGraph(topo(services, edges), { mergedTeams: [1, 2], teamGrouping: false });
    // no meganodes even though both teams are "merged"
    expect(g.nodes.every((n) => n.kind === 'service')).toBe(true);
    expect(g.nodes.map((n) => n.key).sort()).toEqual(
      ['api.stripe.com', 'catalog-svc', 'checkout-svc', 'orders-svc'].sort(),
    );
    expect(g.edges).toHaveLength(4);
    expect(g.nodes.find((n) => n.key === 'checkout-svc')?.teamName).toBe('Checkout');
  });

  it('externals assigned to a team fold into that meganode', () => {
    const withTeam = services.map((s) => (s.id === 'api.stripe.com' ? { ...s, teamId: 1 } : s));
    const g = buildGraph(topo(withTeam, edges), { mergedTeams: [1, 2] });
    expect(g.nodes.some((n) => n.key === 'api.stripe.com')).toBe(false);
    const mega = g.nodes.find((n) => n.key === groupKey(1));
    expect(mega?.memberIds).toContain('api.stripe.com');
    // checkout -> stripe became intra-group and disappeared
    expect(g.edges.some((e) => e.targetKey === 'api.stripe.com')).toBe(false);
  });

  describe('structural sharing with prev', () => {
    const t1 = topo(services, edges);

    it('returns the previous graph when nothing changed', () => {
      const g1 = buildGraph(t1, { mergedTeams: [] });
      const g2 = buildGraph({ ...t1, services: [...t1.services], edges: [...t1.edges] }, { mergedTeams: [], prev: g1 });
      expect(g2).toBe(g1);
    });

    it('reuses unchanged nodes and edges and rebuilds changed ones', () => {
      const g1 = buildGraph(t1, { mergedTeams: [] });
      const bumped = { ...services[2], metrics: { ...services[2].metrics, rps: 999 } };
      const t2 = topo([services[0], services[1], bumped, services[3]], edges);
      const g2 = buildGraph(t2, { mergedTeams: [], prev: g1 });
      expect(g2).not.toBe(g1);
      expect(g2.nodes[0]).toBe(g1.nodes[0]);
      expect(g2.nodes[2]).not.toBe(g1.nodes[2]);
      expect(g2.nodes[2].rps).toBe(999);
      expect(g2.edges).toBe(g1.edges);
    });

    it('reuses a group whose members are unchanged and rebuilds one whose member moved', () => {
      const g1 = buildGraph(t1, { mergedTeams: [1, 2] });
      const same = buildGraph(topo([...services], [...edges]), { mergedTeams: [1, 2], prev: g1 });
      expect(same).toBe(g1);
      const hot = { ...services[0], metrics: { ...services[0].metrics, rps: 5000 } };
      const g2 = buildGraph(topo([hot, services[1], services[2], services[3]], edges), { mergedTeams: [1, 2], prev: g1 });
      const key1 = groupKey(1);
      const key2 = groupKey(2);
      expect(g2.nodes.find((n) => n.key === key1)).not.toBe(g1.nodes.find((n) => n.key === key1));
      expect(g2.nodes.find((n) => n.key === key2)).toBe(g1.nodes.find((n) => n.key === key2));
    });

    it('rebuilds an aggregated edge when one underlying edge changes', () => {
      const g1 = buildGraph(t1, { mergedTeams: [1] });
      const e2 = { ...edges[1], metrics: { ...edges[1].metrics, rps: 77 } };
      const g2 = buildGraph(topo(services, [edges[0], e2, edges[2], edges[3]]), { mergedTeams: [1], prev: g1 });
      const k = `${groupKey(1)}=>catalog-svc`;
      expect(g2.edges.find((e) => e.key === k)).not.toBe(g1.edges.find((e) => e.key === k));
      const ext = `${groupKey(1)}=>api.stripe.com`;
      expect(g2.edges.find((e) => e.key === ext)).toBe(g1.edges.find((e) => e.key === ext));
    });
  });

  it('does not keep the previous graph reachable from the new one', async () => {
    // the live feed rebuilds every frame with `prev`, so a chain here grows
    // the heap by a whole graph per frame
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const frame = (rps: number): Topology => topo(services.map((s) => ({ ...s, metrics: { ...s.metrics, rps } })), edges);
    let g = buildGraph(frame(1), { mergedTeams: [1] });
    const first = new WeakRef(g);
    for (let i = 2; i < 5; i++) g = buildGraph(frame(i), { mergedTeams: [1], prev: g });
    // WeakRefs are only cleared once the current job ends
    await new Promise((r) => setTimeout(r, 0));
    gc();
    expect(first.deref()).toBeUndefined();
    expect(g.nodeKeyOf('orders-svc')).toBe(groupKey(1));
  });
});
