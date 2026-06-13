import { describe, expect, it } from 'vitest';
import type { Graph, GraphNode } from '../../../lib/grouping';
import { buildDimmer } from './dimming';
import type { FocusSet } from './focusSet';

const svc = (key: string, teamId: number | null, label = key): GraphNode => ({
  key,
  kind: 'service',
  serviceId: key,
  teamId,
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

const graph = {
  nodes: [svc('api', 1, 'API Gateway'), svc('cart', 2, 'Cart'), svc('pay', 2, 'Payments')],
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
  });
});
