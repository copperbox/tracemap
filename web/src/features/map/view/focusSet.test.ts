import { describe, expect, it } from 'vitest';
import type { Graph, GraphEdge } from '../../../lib/grouping';
import { computeFocusSet } from './focusSet';

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

// "source depends on target".
//   gateway -> bff -> svc        (callers above svc)
//   svc -> dep -> leaf           (dependencies below svc)
//   bff -> leaf                  (CROSS-LINK: an upstream node also calls a
//                                 downstream node directly -- must NOT light)
//   x -> y                       (separate component)
const graph = {
  nodes: [],
  edges: [
    edge('gateway', 'bff'),
    edge('bff', 'svc'),
    edge('svc', 'dep'),
    edge('dep', 'leaf'),
    edge('bff', 'leaf'),
    edge('x', 'y'),
  ],
  nodeKeyOf: (id: string) => id,
} as unknown as Graph;

const sortNodes = (f: ReturnType<typeof computeFocusSet>) => (f ? [...f.nodes].sort() : null);
const sortEdges = (f: ReturnType<typeof computeFocusSet>) => (f ? [...f.edges].sort() : null);

describe('computeFocusSet', () => {
  it('returns null when nothing is focused', () => {
    expect(computeFocusSet(null, graph)).toBeNull();
  });

  it('lights the call cone of a node: callers up and dependencies down', () => {
    const f = computeFocusSet('svc', graph);
    expect(sortNodes(f)).toEqual(['bff', 'dep', 'gateway', 'leaf', 'svc']);
  });

  it('lights only the traversed links, not a cross-link between the cones', () => {
    // bff (upstream of svc) also calls leaf (downstream of svc). Both nodes are
    // lit, but the bff->leaf link is not on the tree and must stay dimmed.
    const f = computeFocusSet('svc', graph);
    expect(sortEdges(f)).toEqual(['bff=>svc', 'dep=>leaf', 'gateway=>bff', 'svc=>dep']);
    expect(f?.edges.has('bff=>leaf')).toBe(false);
    expect(f?.nodes.has('bff')).toBe(true); // node still lit -- it is a real ancestor
    expect(f?.nodes.has('leaf')).toBe(true);
  });

  it('focuses an edge as callers-up-from-source plus deps-down-from-target', () => {
    const f = computeFocusSet('bff=>svc', graph);
    expect(sortNodes(f)).toEqual(['bff', 'dep', 'gateway', 'leaf', 'svc']);
    // gateway->bff (up from source) and svc->dep->leaf (down from target); the
    // focused edge itself; never the bff->leaf cross-link.
    expect(sortEdges(f)).toEqual(['bff=>svc', 'dep=>leaf', 'gateway=>bff', 'svc=>dep']);
    expect(f?.edges.has('bff=>leaf')).toBe(false);
  });

  it('does not turn around at a node (a sibling caller stays dark)', () => {
    // Focusing dep: up is svc <- bff <- gateway, down is leaf. bff also calls
    // leaf, but that does not pull anything new; svc's other relations are via
    // the up-cone only.
    const f = computeFocusSet('dep', graph);
    expect(sortNodes(f)).toEqual(['bff', 'dep', 'gateway', 'leaf', 'svc']);
    expect(f?.edges.has('bff=>leaf')).toBe(false);
  });

  it('does not bleed into a disconnected component', () => {
    const f = computeFocusSet('svc', graph);
    expect(f?.nodes.has('x')).toBe(false);
    expect(f?.nodes.has('y')).toBe(false);
  });

  it('lights only the small component when focusing inside it', () => {
    const f = computeFocusSet('x=>y', graph);
    expect(sortNodes(f)).toEqual(['x', 'y']);
    expect(sortEdges(f)).toEqual(['x=>y']);
  });

  it('falls back to a lone node with no edges for an unknown id', () => {
    const f = computeFocusSet('ghost', graph);
    expect(sortNodes(f)).toEqual(['ghost']);
    expect(sortEdges(f)).toEqual([]);
  });
});
