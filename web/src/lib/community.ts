/**
 * Community detection for the force-directed ("communities") map view.
 *
 * Uses label propagation over the UNDIRECTED call graph: every service starts
 * in its own community, then repeatedly adopts the community held by most of
 * its neighbors. A node KEEPS its current label whenever that label is already
 * one of the most common among its neighbors, and only otherwise switches --
 * to the largest tied label. That "stay put when already maximal" rule is what
 * keeps the result deterministic without the pathologies of naive variants: it
 * stops a single bridge edge from flooding one cluster's label across another,
 * keeps a hub and its spokes in one community instead of oscillating, and
 * always converges. Nodes are visited in a fixed sorted order and updated in
 * place.
 *
 * Communities are derived from graph STRUCTURE only -- which services call
 * which -- and never from live metrics, so they stay stable across the topology
 * polls that refresh rps/latency and only shift when the topology itself
 * changes. (Same reasoning as the structure-keyed layout in MapView.)
 */

export interface CommunityEdge {
  sourceKey: string;
  targetKey: string;
}

export interface CommunityResult {
  /** node key -> community id; ids are contiguous 0..count-1, largest first. */
  byNode: Map<string, number>;
  /** number of distinct communities. */
  count: number;
}

const MAX_ITERS = 50;

export function detectCommunities(nodeKeys: string[], edges: CommunityEdge[]): CommunityResult {
  const keys = [...nodeKeys].sort();
  if (!keys.length) return { byNode: new Map(), count: 0 };

  // Undirected adjacency. A mutual pair (A->B and B->A) lists each twice,
  // which simply weights that tighter coupling more -- the desired bias.
  const adj = new Map<string, string[]>();
  const present = new Set(keys);
  for (const k of keys) adj.set(k, []);
  for (const e of edges) {
    if (e.sourceKey === e.targetKey) continue;
    if (!present.has(e.sourceKey) || !present.has(e.targetKey)) continue;
    (adj.get(e.sourceKey) as string[]).push(e.targetKey);
    (adj.get(e.targetKey) as string[]).push(e.sourceKey);
  }

  // Integer labels keyed off the sorted index keep tie-breaks cheap and stable.
  const labelIndex = new Map(keys.map((k, i) => [k, i]));
  const label = new Map(keys.map((k) => [k, labelIndex.get(k) as number]));

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let changed = false;
    for (const k of keys) {
      const neighbors = adj.get(k) as string[];
      if (!neighbors.length) continue;
      const counts = new Map<number, number>();
      for (const nb of neighbors) {
        const l = label.get(nb) as number;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      const cur = label.get(k) as number;
      const ownCount = counts.get(cur) ?? 0;
      let maxCount = ownCount;
      for (const c of counts.values()) if (c > maxCount) maxCount = c;

      // Already among the most common labels -> stay put. Otherwise adopt the
      // largest label that ties for most common.
      let best = cur;
      if (ownCount < maxCount) {
        best = -1;
        for (const [l, c] of counts) if (c === maxCount && l > best) best = l;
      }
      if (best !== cur) {
        label.set(k, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Renumber to contiguous ids, largest community first (ties by smallest
  // member key) so the color palette assigns the most prominent hues to the
  // biggest clusters and the mapping is reproducible.
  const members = new Map<number, string[]>();
  for (const k of keys) {
    const l = label.get(k) as number;
    const arr = members.get(l) ?? [];
    arr.push(k);
    members.set(l, arr);
  }
  const ordered = [...members.values()].sort(
    (a, b) => b.length - a.length || a[0].localeCompare(b[0]),
  );
  const byNode = new Map<string, number>();
  ordered.forEach((group, id) => {
    for (const k of group) byNode.set(k, id);
  });

  return { byNode, count: ordered.length };
}
