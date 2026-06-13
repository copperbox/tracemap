import type { GraphEdge, GraphNode } from './grouping';
import { GROUP_H, GROUP_W, layoutGraph, NODE_H, NODE_W, type LayoutResult } from './layout';

/**
 * Two-level layout that keeps each unmerged team's services together so the
 * map can draw a "frame" around them (like a box on an infrastructure
 * diagram). Members of a team are laid out among themselves first; the
 * resulting frame, every merged-team meganode, and every teamless service
 * then go through the same layered flow layout at cluster granularity.
 */

/** Padding between a frame's border and the member cards inside it. */
export const FRAME_PAD = 20;
/** Vertical room reserved at the top of a frame for its title bar. */
export const FRAME_TITLE_H = 36;

/**
 * The cluster a node belongs to. A team gets the SAME cluster key whether it
 * is currently a frame of services or a merged meganode, so toggling a team
 * keeps it in the same layer and ordering slot -- it expands/collapses in
 * place instead of being re-located across the map.
 */
const clusterOf = (n: GraphNode): string => (n.teamId != null ? `team:${n.teamId}` : n.key);

export function layoutClusteredGraph(nodes: GraphNode[], edges: GraphEdge[]): LayoutResult {
  if (!nodes.length) return { pos: new Map(), bbox: { x0: 0, y0: 0, x1: 0, y1: 0 } };

  const nodeByKey = new Map(nodes.map((n) => [n.key, n]));
  const members = new Map<string, GraphNode[]>();
  for (const n of [...nodes].sort((a, b) => a.key.localeCompare(b.key))) {
    const ck = clusterOf(n);
    const arr = members.get(ck) ?? [];
    arr.push(n);
    members.set(ck, arr);
  }

  const sortedEdges = [...edges].sort((a, b) => a.key.localeCompare(b.key));

  // lay out each frame's members among themselves (intra-team edges only)
  // and record where each member sits relative to the frame's top-left
  const offsets = new Map<string, { x: number; y: number }>();
  const dims = new Map<string, { w: number; h: number }>();
  for (const [ck, mem] of members) {
    const lone = mem.length === 1 && (mem[0].kind === 'group' || mem[0].teamId == null) ? mem[0] : null;
    if (lone) {
      // standalone cluster: a merged team's meganode or a teamless service
      dims.set(ck, lone.kind === 'group' ? { w: GROUP_W, h: GROUP_H } : { w: NODE_W, h: NODE_H });
      continue;
    }
    const keys = mem.map((m) => m.key);
    const keySet = new Set(keys);
    const deps = new Map<string, string[]>();
    for (const e of sortedEdges) {
      if (!keySet.has(e.sourceKey) || !keySet.has(e.targetKey)) continue;
      const arr = deps.get(e.sourceKey) ?? [];
      arr.push(e.targetKey);
      deps.set(e.sourceKey, arr);
    }
    const local = layoutGraph({ keys, deps });
    for (const k of keys) {
      const p = local.pos.get(k) as { x: number; y: number };
      offsets.set(k, {
        x: FRAME_PAD + (p.x - local.bbox.x0),
        y: FRAME_TITLE_H + (p.y - local.bbox.y0),
      });
    }
    dims.set(ck, {
      w: local.bbox.x1 - local.bbox.x0 + 2 * FRAME_PAD,
      h: local.bbox.y1 - local.bbox.y0 + FRAME_TITLE_H + FRAME_PAD,
    });
  }

  // cluster-level flow graph over aggregated inter-cluster dependencies
  const clusterDeps = new Map<string, Set<string>>();
  for (const e of sortedEdges) {
    const cs = clusterOf(nodeByKey.get(e.sourceKey) as GraphNode);
    const ct = clusterOf(nodeByKey.get(e.targetKey) as GraphNode);
    if (cs === ct) continue;
    const set = clusterDeps.get(cs) ?? new Set();
    set.add(ct);
    clusterDeps.set(cs, set);
  }
  const top = layoutGraph({
    keys: [...members.keys()].sort(),
    deps: new Map([...clusterDeps].map(([k, v]) => [k, [...v]])),
    dims,
  });

  const pos = new Map<string, { x: number; y: number }>();
  for (const [ck, mem] of members) {
    const cp = top.pos.get(ck) as { x: number; y: number };
    for (const m of mem) {
      const off = offsets.get(m.key) ?? { x: 0, y: 0 };
      pos.set(m.key, { x: cp.x + off.x, y: cp.y + off.y });
    }
  }
  return { pos, bbox: top.bbox };
}
