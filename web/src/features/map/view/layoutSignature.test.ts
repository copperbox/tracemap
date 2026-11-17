import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '../../../lib/grouping';
import { layoutSignature } from './layoutSignature';

const node = (key: string, teamId: number | null, over: Partial<GraphNode> = {}): GraphNode => ({
  key,
  kind: 'service',
  serviceId: key,
  teamId,
  teamName: teamId == null ? null : `team ${teamId}`,
  label: key,
  type: 'service',
  status: 'ok',
  rps: 1,
  p95: 10,
  errPct: 0,
  stale: false,
  isExternal: false,
  memberIds: [],
  ...over,
});

const edge = (sourceKey: string, targetKey: string): GraphEdge => ({
  key: `${sourceKey}=>${targetKey}`,
  sourceKey,
  targetKey,
  status: 'ok',
  rps: 10,
  p95: 50,
  errPct: 0.1,
  stale: false,
  confidence: 99,
  samples: 100,
  underlying: [],
});

const nodes = [node('a', 1), node('b', 1), node('c', 2)];
const edges = [edge('a', 'b'), edge('b', 'c')];

describe('layoutSignature', () => {
  it('keeps the signature across a metrics-only frame', () => {
    const s1 = layoutSignature(null, nodes, edges, true);
    const fresh = nodes.map((n) => ({ ...n, rps: n.rps + 5, status: 'crit' as const }));
    const s2 = layoutSignature(s1, fresh, edges.map((e) => ({ ...e })), true);
    expect(s2.sig).toBe(s1.sig);
    expect(s2.nodes).toBe(fresh);
  });

  it('returns the previous state when the lists are the same arrays', () => {
    const s1 = layoutSignature(null, nodes, edges, true);
    expect(layoutSignature(s1, nodes, edges, true)).toBe(s1);
  });

  it('changes when a service moves to another team with the same ids', () => {
    const s1 = layoutSignature(null, nodes, edges, true);
    const moved = [nodes[0], node('b', 2), nodes[2]];
    expect(layoutSignature(s1, moved, edges, true).sig).not.toBe(s1.sig);
  });

  it('changes when a service loses its team (becomes unassigned)', () => {
    const s1 = layoutSignature(null, nodes, edges, true);
    const loose = [nodes[0], nodes[1], node('c', null)];
    expect(layoutSignature(s1, loose, edges, true).sig).not.toBe(s1.sig);
  });

  it('changes when a node changes size (service vs group box)', () => {
    const s1 = layoutSignature(null, nodes, edges, true);
    const grown = [nodes[0], nodes[1], node('c', 2, { kind: 'group' })];
    expect(layoutSignature(s1, grown, edges, true).sig).not.toBe(s1.sig);
  });

  it('ignores order but not grouping', () => {
    const s1 = layoutSignature(null, nodes, edges, true);
    expect(layoutSignature(null, [...nodes].reverse(), [...edges].reverse(), true).sig).toBe(s1.sig);
    expect(layoutSignature(s1, nodes, edges, false).sig).not.toBe(s1.sig);
  });

  it('changes when an edge is replaced', () => {
    const s1 = layoutSignature(null, nodes, edges, true);
    expect(layoutSignature(s1, nodes, [edge('a', 'b'), edge('a', 'c')], true).sig).not.toBe(s1.sig);
  });
});
