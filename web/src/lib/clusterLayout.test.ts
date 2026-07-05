import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from './grouping';
import { FRAME_PAD, FRAME_TITLE_H, layoutClusteredGraph } from './clusterLayout';
import { GROUP_H, GROUP_W, layoutGraph, NODE_H, NODE_W } from './layout';

const svcNode = (key: string, teamId: number | null): GraphNode => ({
  key,
  kind: 'service',
  serviceId: key,
  teamId,
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

const groupNode = (teamId: number, memberIds: string[]): GraphNode => ({
  key: `group:${teamId}`,
  kind: 'group',
  teamId,
  teamName: null,
  label: `team ${teamId}`,
  type: 'group',
  status: 'ok',
  rps: 1,
  p95: 10,
  errPct: 0,
  stale: false,
  isExternal: false,
  memberIds,
});

const edge = (sourceKey: string, targetKey: string): GraphEdge => ({
  key: `${sourceKey}=>${targetKey}`,
  sourceKey,
  targetKey,
  status: 'ok',
  rps: 1,
  p95: 10,
  errPct: 0,
  stale: false,
  confidence: 99,
  samples: 100,
  underlying: [],
});

/** Frame rect for a team, the same way the map view derives it. */
const frameRect = (pos: Map<string, { x: number; y: number }>, keys: string[]) => {
  const xs = keys.map((k) => (pos.get(k) as { x: number }).x);
  const ys = keys.map((k) => (pos.get(k) as { y: number }).y);
  return {
    x0: Math.min(...xs) - FRAME_PAD,
    y0: Math.min(...ys) - FRAME_TITLE_H,
    x1: Math.max(...xs) + NODE_W + FRAME_PAD,
    y1: Math.max(...ys) + NODE_H + FRAME_PAD,
  };
};

type Rect = { x0: number; y0: number; x1: number; y1: number };
const overlaps = (a: Rect, b: Rect): boolean =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

describe('layoutClusteredGraph', () => {
  const nodes = [
    svcNode('checkout-svc', 1),
    svcNode('orders-svc', 1),
    svcNode('catalog-svc', 2),
    svcNode('search-svc', 2),
    svcNode('api.stripe.com', null),
  ];
  const edges = [
    edge('checkout-svc', 'orders-svc'),
    edge('checkout-svc', 'catalog-svc'),
    edge('orders-svc', 'catalog-svc'),
    edge('catalog-svc', 'search-svc'),
    edge('checkout-svc', 'api.stripe.com'),
  ];

  it('positions every node', () => {
    const { pos } = layoutClusteredGraph(nodes, edges);
    for (const n of nodes) expect(pos.has(n.key)).toBe(true);
  });

  it('keeps teammates inside a frame that does not overlap other frames', () => {
    const { pos } = layoutClusteredGraph(nodes, edges);
    const f1 = frameRect(pos, ['checkout-svc', 'orders-svc']);
    const f2 = frameRect(pos, ['catalog-svc', 'search-svc']);
    expect(overlaps(f1, f2)).toBe(false);
  });

  it('keeps teamless nodes outside every frame', () => {
    const { pos } = layoutClusteredGraph(nodes, edges);
    const f1 = frameRect(pos, ['checkout-svc', 'orders-svc']);
    const f2 = frameRect(pos, ['catalog-svc', 'search-svc']);
    const p = pos.get('api.stripe.com') as { x: number; y: number };
    const r = { x0: p.x, y0: p.y, x1: p.x + NODE_W, y1: p.y + NODE_H };
    expect(overlaps(r, f1)).toBe(false);
    expect(overlaps(r, f2)).toBe(false);
  });

  it('separates teammates enough for their cards not to overlap', () => {
    const { pos } = layoutClusteredGraph(nodes, edges);
    const a = pos.get('checkout-svc') as { x: number; y: number };
    const b = pos.get('orders-svc') as { x: number; y: number };
    const ra = { x0: a.x, y0: a.y, x1: a.x + NODE_W, y1: a.y + NODE_H };
    const rb = { x0: b.x, y0: b.y, x1: b.x + NODE_W, y1: b.y + NODE_H };
    expect(overlaps(ra, rb)).toBe(false);
  });

  it('lays out merged meganodes alongside frames without overlap', () => {
    const merged = [groupNode(1, ['checkout-svc', 'orders-svc']), svcNode('catalog-svc', 2), svcNode('search-svc', 2)];
    const megaEdges = [edge('group:1', 'catalog-svc'), edge('catalog-svc', 'search-svc')];
    const { pos } = layoutClusteredGraph(merged, megaEdges);
    const g = pos.get('group:1') as { x: number; y: number };
    const rg = { x0: g.x, y0: g.y, x1: g.x + GROUP_W, y1: g.y + GROUP_H };
    const f2 = frameRect(pos, ['catalog-svc', 'search-svc']);
    expect(overlaps(rg, f2)).toBe(false);
  });

  it('keeps a toggled team in the same flow slot (in-place merge/unmerge)', () => {
    const chainNodes = [
      svcNode('a1', 1),
      svcNode('a2', 1),
      svcNode('b1', 2),
      svcNode('b2', 2),
      svcNode('c1', 3),
      svcNode('c2', 3),
    ];
    const chainEdges = [
      edge('a1', 'a2'),
      edge('a1', 'b1'),
      edge('b1', 'b2'),
      edge('b2', 'c1'),
      edge('c1', 'c2'),
    ];
    const unmerged = layoutClusteredGraph(chainNodes, chainEdges);

    // same topology with team 2 merged into its meganode
    const mergedNodes = [
      svcNode('a1', 1),
      svcNode('a2', 1),
      groupNode(2, ['b1', 'b2']),
      svcNode('c1', 3),
      svcNode('c2', 3),
    ];
    const mergedEdges = [edge('a1', 'a2'), edge('a1', 'group:2'), edge('group:2', 'c1'), edge('c1', 'c2')];
    const merged = layoutClusteredGraph(mergedNodes, mergedEdges);

    const cy = (pos: Map<string, { x: number; y: number }>, keys: string[], h: number) => {
      const ys = keys.map((k) => (pos.get(k) as { y: number }).y);
      return (Math.min(...ys) + Math.max(...ys) + h) / 2;
    };
    const u = [
      cy(unmerged.pos, ['a1', 'a2'], NODE_H),
      cy(unmerged.pos, ['b1', 'b2'], NODE_H),
      cy(unmerged.pos, ['c1', 'c2'], NODE_H),
    ];
    const m = [
      cy(merged.pos, ['a1', 'a2'], NODE_H),
      cy(merged.pos, ['group:2'], GROUP_H),
      cy(merged.pos, ['c1', 'c2'], NODE_H),
    ];
    // the vertical order of the three teams is identical in both layouts,
    // so toggling team 2 does not relocate it across the map
    expect(Math.sign(u[0] - u[1])).toBe(Math.sign(m[0] - m[1]));
    expect(Math.sign(u[1] - u[2])).toBe(Math.sign(m[1] - m[2]));
  });

  describe('with team grouping off', () => {
    // A plain layered layout over every node, with no team clustering -- the
    // "different algorithm" the flat mode is expected to reproduce.
    const flatReference = () => {
      const keys = [...nodes].map((n) => n.key).sort((a, b) => a.localeCompare(b));
      const keySet = new Set(keys);
      const deps = new Map<string, string[]>();
      for (const e of [...edges].sort((a, b) => a.key.localeCompare(b.key))) {
        if (!keySet.has(e.sourceKey) || !keySet.has(e.targetKey)) continue;
        const arr = deps.get(e.sourceKey) ?? [];
        arr.push(e.targetKey);
        deps.set(e.sourceKey, arr);
      }
      const dims = new Map(nodes.map((n) => [n.key, { w: NODE_W, h: NODE_H }]));
      return layoutGraph({ keys, deps, dims });
    };

    it('positions every node', () => {
      const { pos } = layoutClusteredGraph(nodes, edges, { teamGrouping: false });
      for (const n of nodes) expect(pos.has(n.key)).toBe(true);
    });

    it('lays services out flat, ignoring team clusters', () => {
      const flat = layoutClusteredGraph(nodes, edges, { teamGrouping: false });
      const plain = flatReference();
      expect([...flat.pos.entries()]).toEqual([...plain.pos.entries()]);
    });

    it('produces a different layout than the grouped one', () => {
      const grouped = layoutClusteredGraph(nodes, edges);
      const flat = layoutClusteredGraph(nodes, edges, { teamGrouping: false });
      expect([...flat.pos.entries()]).not.toEqual([...grouped.pos.entries()]);
    });
  });

  it('is deterministic for the same input', () => {
    const a = layoutClusteredGraph(nodes, edges);
    const b = layoutClusteredGraph(nodes, edges);
    expect([...a.pos.entries()]).toEqual([...b.pos.entries()]);
  });

  it('handles an empty graph', () => {
    const { pos, bbox } = layoutClusteredGraph([], []);
    expect(pos.size).toBe(0);
    expect(bbox).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 });
  });
});
