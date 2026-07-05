import { describe, expect, it } from 'vitest';
import type { Graph, GraphNode } from '../../../lib/grouping';
import { buildDimmer } from './dimming';
import type { FocusSet } from './focusSet';

const svc = (key: string, teamId: number | null, label = key): GraphNode => ({
  key,
  kind: 'service',
  serviceId: key,
  teamId,
  teamName: null,
  label,
  type: 'service',
  status: 'ok',
  rps: 1,
  p95: null,
  errPct: 0,
  stale: false,
  isExternal: false,
  memberIds: [],
});

const group = (teamId: number, label: string): GraphNode =>
  ({ ...svc(`group:${teamId}`, teamId, label), kind: 'group', type: 'group' }) as GraphNode;

const graph = {
  nodes: [
    svc('api', 1, 'API Gateway'),
    svc('cart', 2, 'Cart'),
    svc('pay', 2, 'Payments'),
    svc('inferred', null, 'Inferred peer'),
  ],
  edges: [],
  nodeKeyOf: (id: string) => id,
} as unknown as Graph;

describe('buildDimmer', () => {
  it('dims nothing with no focus, query, or filter', () => {
    const d = buildDimmer(graph, { focus: null, query: '', teamFilter: 'all' });
    expect(d('api')).toBe(false);
    expect(d('cart')).toBe(false);
  });

  it('dims unknown keys', () => {
    const d = buildDimmer(graph, { focus: null, query: '', teamFilter: 'all' });
    expect(d('ghost')).toBe(true);
  });

  it('dims nodes outside the focus cone', () => {
    const focus: FocusSet = { nodes: new Set(['api']), edges: new Set() };
    const d = buildDimmer(graph, { focus, query: '', teamFilter: 'all' });
    expect(d('api')).toBe(false);
    expect(d('cart')).toBe(true);
  });

  it('dims nodes not matching the search query (by key or label)', () => {
    const d = buildDimmer(graph, { focus: null, query: 'gateway', teamFilter: 'all' });
    expect(d('api')).toBe(false); // matches label "API Gateway"
    expect(d('cart')).toBe(true);
  });

  it('dims nodes owned by a non-selected team', () => {
    const d = buildDimmer(graph, { focus: null, query: '', teamFilter: 2 });
    expect(d('api')).toBe(true);
    expect(d('cart')).toBe(false);
    expect(d('pay')).toBe(false);
    expect(d('inferred')).toBe(true);
  });

  it("under 'none', keeps only team-less services and dims team groups", () => {
    const g = {
      nodes: [...graph.nodes, group(2, 'Cart Team')],
      edges: [],
      nodeKeyOf: (id: string) => id,
    } as unknown as Graph;
    const d = buildDimmer(g, { focus: null, query: '', teamFilter: 'none' });
    expect(d('inferred')).toBe(false); // unassigned -> kept
    expect(d('api')).toBe(true); // owned -> dimmed
    expect(d('cart')).toBe(true);
    expect(d('group:2')).toBe(true); // a team meganode is never "unassigned"
  });
});
