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

  it('externals assigned to a team fold into that meganode', () => {
    const withTeam = services.map((s) => (s.id === 'api.stripe.com' ? { ...s, teamId: 1 } : s));
    const g = buildGraph(topo(withTeam, edges), { mergedTeams: [1, 2] });
    expect(g.nodes.some((n) => n.key === 'api.stripe.com')).toBe(false);
    const mega = g.nodes.find((n) => n.key === groupKey(1));
    expect(mega?.memberIds).toContain('api.stripe.com');
    // checkout -> stripe became intra-group and disappeared
    expect(g.edges.some((e) => e.targetKey === 'api.stripe.com')).toBe(false);
  });
});
