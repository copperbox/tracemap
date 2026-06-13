import type { Graph } from '../../../lib/grouping';

export interface FocusSet {
  /** Node keys to keep lit. */
  nodes: Set<string>;
  /**
   * Edge keys to keep lit. Only the links actually walked from the seed are
   * included, so an incidental edge bridging the upstream and downstream cones
   * (e.g. an ancestor that also calls a descendant directly) stays dimmed even
   * though both its endpoints are lit.
   */
  edges: Set<string>;
}

interface Adj {
  to: string;
  key: string;
}

/**
 * The focus subgraph for a node or edge: the dependency tree it sits in.
 *
 * `focusId` is either a node key (service id or "group:<teamId>") or an edge
 * key ("<sourceKey>=><targetKey>"). The walk is directional and never turns
 * around at a node: it follows callers upstream and dependencies downstream
 * from the seed, so it traces the call cone rather than flooding the whole
 * connected component. A node focus seeds from that node; an edge focus walks
 * callers up from the source and dependencies down from the target.
 *
 * Both the visited nodes and the traversed edges are returned, so the renderer
 * can dim cross-links that merely happen to join two lit nodes. Returns null
 * when nothing is focused.
 */
export function computeFocusSet(focusId: string | null, graph: Graph): FocusSet | null {
  if (!focusId) return null;

  // Directed adjacency carrying the edge key. An edge source->target means
  // "source depends on target": outAdj walks downstream to dependencies, inAdj
  // walks upstream to callers.
  const outAdj = new Map<string, Adj[]>();
  const inAdj = new Map<string, Adj[]>();
  const push = (m: Map<string, Adj[]>, key: string, adj: Adj) => {
    const list = m.get(key);
    if (list) list.push(adj);
    else m.set(key, [adj]);
  };
  for (const e of graph.edges) {
    push(outAdj, e.sourceKey, { to: e.targetKey, key: e.key });
    push(inAdj, e.targetKey, { to: e.sourceKey, key: e.key });
  }

  const nodes = new Set<string>();
  const edges = new Set<string>();
  // BFS in one direction; every link encountered along the way joins the tree.
  const walk = (start: string, adj: Map<string, Adj[]>) => {
    nodes.add(start);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift() as string;
      for (const { to, key } of adj.get(cur) ?? []) {
        edges.add(key);
        if (!nodes.has(to)) {
          nodes.add(to);
          queue.push(to);
        }
      }
    }
  };

  const focusEdge = graph.edges.find((e) => e.key === focusId);
  if (focusEdge) {
    nodes.add(focusEdge.sourceKey);
    nodes.add(focusEdge.targetKey);
    edges.add(focusEdge.key);
    walk(focusEdge.sourceKey, inAdj); // callers up from the source
    walk(focusEdge.targetKey, outAdj); // dependencies down from the target
  } else {
    walk(focusId, inAdj); // ancestors (transitive callers)
    walk(focusId, outAdj); // descendants (transitive dependencies)
  }
  return { nodes, edges };
}
