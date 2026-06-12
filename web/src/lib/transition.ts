import type { GraphNode } from './grouping';
import { GROUP_H, GROUP_W, NODE_H, NODE_W } from './layout';

/**
 * Computes how to animate the map between two graph structures so that
 * grouping/ungrouping reads as a merge/split instead of a snap:
 * - surviving nodes glide from their old position to the new one
 * - services revealed by ungrouping fly out of their old group's position
 * - services collapsed into a group linger as fading "ghosts" that converge
 *   on the new group node, which fades in at its final position
 * - nodes/edges with no counterpart simply fade in/out in place
 */

export interface Pos {
  x: number;
  y: number;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  pos: Map<string, Pos>;
  edgeKeys: Set<string>;
}

export interface GhostNode {
  node: GraphNode;
  from: Pos;
  to: Pos;
}

export interface GraphTransition {
  /** Start positions for next-graph nodes that glide to their target. */
  from: Map<string, Pos>;
  /** Next-graph node keys that fade in at their target position. */
  appear: Set<string>;
  /** Removed nodes that linger, gliding from `from` to `to` while fading out. */
  ghosts: GhostNode[];
  /** Edge keys new to the next graph; these fade in. */
  newEdges: Set<string>;
}

const sizeOf = (n: GraphNode): { w: number; h: number } =>
  n.kind === 'group' ? { w: GROUP_W, h: GROUP_H } : { w: NODE_W, h: NODE_H };

/** Top-left for `inner` so its center matches `outer` placed at `pos`. */
const centerOn = (pos: Pos, outer: GraphNode, inner: GraphNode): Pos => {
  const a = sizeOf(outer);
  const b = sizeOf(inner);
  return { x: pos.x + (a.w - b.w) / 2, y: pos.y + (a.h - b.h) / 2 };
};

export function computeGraphTransition(prev: GraphSnapshot, next: GraphSnapshot): GraphTransition {
  const prevByKey = new Map(prev.nodes.map((n) => [n.key, n]));
  const nextByKey = new Map(next.nodes.map((n) => [n.key, n]));

  // service id -> the group node holding it, per graph
  const groupOf = (nodes: GraphNode[]): Map<string, GraphNode> => {
    const m = new Map<string, GraphNode>();
    for (const n of nodes) {
      if (n.kind !== 'group') continue;
      for (const id of n.memberIds) m.set(id, n);
    }
    return m;
  };
  const prevGroupOf = groupOf(prev.nodes);
  const nextGroupOf = groupOf(next.nodes);

  const from = new Map<string, Pos>();
  const appear = new Set<string>();
  for (const n of next.nodes) {
    const target = next.pos.get(n.key);
    if (!target) continue;
    if (prevByKey.has(n.key)) {
      const pp = prev.pos.get(n.key);
      if (pp && (pp.x !== target.x || pp.y !== target.y)) from.set(n.key, pp);
      continue;
    }
    if (n.kind === 'service') {
      const g = prevGroupOf.get(n.key);
      const gp = g ? prev.pos.get(g.key) : undefined;
      if (g && gp) {
        from.set(n.key, centerOn(gp, g, n));
        continue;
      }
    }
    appear.add(n.key);
  }

  const ghosts: GhostNode[] = [];
  for (const n of prev.nodes) {
    if (nextByKey.has(n.key)) continue;
    const pp = prev.pos.get(n.key);
    if (!pp) continue;
    if (n.kind === 'service') {
      const g = nextGroupOf.get(n.key);
      const gp = g ? next.pos.get(g.key) : undefined;
      if (g && gp) {
        ghosts.push({ node: n, from: pp, to: centerOn(gp, g, n) });
        continue;
      }
    }
    ghosts.push({ node: n, from: pp, to: pp });
  }

  const newEdges = new Set([...next.edgeKeys].filter((k) => !prev.edgeKeys.has(k)));

  return { from, appear, ghosts, newEdges };
}
