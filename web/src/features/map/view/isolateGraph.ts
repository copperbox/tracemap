import type { Graph } from '../../../lib/grouping';
import { computeFocusSet } from './focusSet';

/**
 * Restrict the graph to the dependency tree of `isolateId`, dropping every node
 * and edge outside it. Where focus merely dims the surrounding graph,
 * isolation removes it: the layout, culling and render only ever deal with the
 * subtree, which is what makes a large dependency tree legible.
 *
 * The kept set is exactly the focus cone (callers up + dependencies down, same
 * as the focus highlight), so incidental cross-links between two cones are left
 * out rather than drawn.
 *
 * Returns the original graph unchanged when nothing is isolated, or when the id
 * resolves to no nodes actually present (a stale or unknown selection), so the
 * map never blanks out to an empty canvas.
 */
export function isolateGraph(graph: Graph, isolateId: string | null): Graph {
  if (!isolateId) return graph;
  const set = computeFocusSet(isolateId, graph);
  if (!set) return graph;
  const nodes = graph.nodes.filter((n) => set.nodes.has(n.key));
  if (!nodes.length) return graph; // stale id -> show everything rather than nothing
  const edges = graph.edges.filter((e) => set.edges.has(e.key));
  return { nodes, edges, nodeKeyOf: graph.nodeKeyOf };
}
