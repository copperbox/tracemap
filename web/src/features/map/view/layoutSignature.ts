import type { GraphEdge, GraphNode } from '../../../lib/grouping';

/**
 * Structural signature of a graph: everything the layout reads, nothing that
 * a metrics frame changes. layoutClusteredGraph reads each node's key, its
 * kind (a group gets the larger box) and its team (which cluster it packs
 * into), and each edge's endpoints (encoded in its key). Two graphs with the
 * same signature lay out identically.
 */
export interface LayoutSigState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  grouping: boolean;
  sig: string;
}

const nodePart = (n: GraphNode): string => `${n.key}\u0001${n.kind}\u0001${n.teamId ?? ''}`;

const sameNodeShape = (a: GraphNode[], b: GraphNode[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x !== y && (x.key !== y.key || x.kind !== y.kind || x.teamId !== y.teamId)) return false;
  }
  return true;
};

const sameEdgeKeys = (a: GraphEdge[], b: GraphEdge[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && a[i].key !== b[i].key) return false;
  return true;
};

/**
 * The signature for `nodes`/`edges`, skipping the sort when the lists match
 * `prev` entry by entry (the common case: a metrics-only frame).
 */
export function layoutSignature(
  prev: LayoutSigState | null,
  nodes: GraphNode[],
  edges: GraphEdge[],
  grouping: boolean,
): LayoutSigState {
  if (prev && prev.grouping === grouping && sameNodeShape(prev.nodes, nodes) && sameEdgeKeys(prev.edges, edges)) {
    return prev.nodes === nodes && prev.edges === edges ? prev : { ...prev, nodes, edges };
  }
  const sig =
    (grouping ? 'grouped#' : 'flat#') +
    nodes.map(nodePart).sort().join('|') +
    '#' +
    edges
      .map((e) => e.key)
      .sort()
      .join('|');
  return { nodes, edges, grouping, sig };
}
