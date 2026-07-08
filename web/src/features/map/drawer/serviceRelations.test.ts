import { describe, expect, it } from 'vitest';
import type { Topology, TopologyEdge, TopologyService } from '../../../api/types';
import { serviceMeta, serviceRelations } from './serviceRelations';

const svc = (id: string, over: Partial<TopologyService> = {}): TopologyService => ({
  id,
  name: id,
  description: null,
  type: 'service',
  teamId: 1,
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

const edge = (source: string, target: string): TopologyEdge => ({
  source,
  target,
  firstSeen: '2026-06-01T00:00:00Z',
  lastSeen: '2026-06-11T00:00:00Z',
  samples: 1000,
  manual: false,
  confidence: 99,
  status: 'ok',
  metrics: { rps: 10, p50: 5, p95: 20, p99: 40, errPct: 0.2, stale: false },
});

const topo = (services: TopologyService[], edges: TopologyEdge[]): Topology => ({
  services,
  edges,
  teams: [{ id: 1, name: 'Checkout' }],
  generatedAt: '2026-06-11T00:00:00Z',
});

describe('serviceRelations', () => {
  const t = topo(
    [svc('a'), svc('b'), svc('c'), svc('d')],
    [edge('a', 'b'), edge('c', 'b'), edge('b', 'd'), edge('a', 'd')],
  );

  it('splits topology edges into callers (inbound) and dependencies (outbound)', () => {
    const { callers, dependencies } = serviceRelations(t, 'b');
    expect(callers.map((e) => e.source)).toEqual(['a', 'c']);
    expect(dependencies.map((e) => e.target)).toEqual(['d']);
  });

  it('returns empty lists for an unconnected service', () => {
    const { callers, dependencies } = serviceRelations(t, 'zzz');
    expect(callers).toEqual([]);
    expect(dependencies).toEqual([]);
  });
});

describe('serviceMeta', () => {
  it('joins runtime, region and liveness with dots', () => {
    const s = svc('a', { runtime: 'go1.22', region: 'eu-west-1' });
    expect(serviceMeta(s)).toBe('go1.22 · eu-west-1 · live');
  });

  it('drops missing fields and reports stale services', () => {
    const s = svc('a', { metrics: { rps: 0, p50: null, p95: null, p99: null, errPct: 0, stale: true } });
    expect(serviceMeta(s)).toBe('no recent traffic');
  });
});
