import { describe, expect, it } from 'vitest';
import type { Graph, GraphEdge, GraphNode } from '../../../lib/grouping';
import { isolateGraph } from './isolateGraph';

const node = (key: string): GraphNode => ({
  key,
  kind: 'service',
  serviceId: key,
  teamId: null,
  teamName: null,
  label: key,
  type: 'service',
  status: 'ok',
  rps: 1,
  p95: 10,
  errPct: 0,
  stale: false,
  isExternal: false,
  memberIds: [],
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

// gateway -> bff -> svc -> dep -> leaf, plus a bff -> leaf cross-link, plus a
// disconnected x -> y component.
const graph: Graph = {
  nodes: ['gateway', 'bff', 'svc', 'dep', 'leaf', 'x', 'y'].map(node),
  edges: [
    edge('gateway', 'bff'),
    edge('bff', 'svc'),
    edge('svc', 'dep'),
    edge('dep', 'leaf'),
    edge('bff', 'leaf'),
    edge('x', 'y'),
  ],
  nodeKeyOf: (id) => id,
};

const keys = (g: Graph) => ({
  nodes: g.nodes.map((n) => n.key).sort(),
  edges: g.edges.map((e) => e.key).sort(),
});

describe('isolateGraph', () => {
  it('returns the same graph reference when nothing is isolated', () => {
    expect(isolateGraph(graph, null)).toBe(graph);
  });

  it('keeps only the call cone of a node and its traversed edges', () => {
    const out = isolateGraph(graph, 'svc');
    expect(keys(out)).toEqual({
      nodes: ['bff', 'dep', 'gateway', 'leaf', 'svc'],
      edges: ['bff=>svc', 'dep=>leaf', 'gateway=>bff', 'svc=>dep'],
    });
  });

  it('drops the cross-link that the focus walk never traverses', () => {
    const out = isolateGraph(graph, 'svc');
    // bff and leaf are both kept, but the incidental bff->leaf edge is not.
    expect(out.edges.some((e) => e.key === 'bff=>leaf')).toBe(false);
  });

  it('excludes a disconnected component', () => {
    const out = isolateGraph(graph, 'svc');
    expect(out.nodes.some((n) => n.key === 'x')).toBe(false);
  });

  it('isolates an edge as callers-up plus dependencies-down', () => {
    const out = isolateGraph(graph, 'bff=>svc');
    expect(keys(out)).toEqual({
      nodes: ['bff', 'dep', 'gateway', 'leaf', 'svc'],
      edges: ['bff=>svc', 'dep=>leaf', 'gateway=>bff', 'svc=>dep'],
    });
  });

  it('falls back to the full graph for a stale id with no matching node', () => {
    expect(isolateGraph(graph, 'ghost')).toBe(graph);
  });

  it('preserves the nodeKeyOf resolver on the isolated graph', () => {
    const out = isolateGraph(graph, 'svc');
    expect(out.nodeKeyOf).toBe(graph.nodeKeyOf);
  });
});
