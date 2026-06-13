/**
 * A custom d3-force that gently pulls each node toward the live centroid of
 * its community. Combined with charge repulsion and link attraction, this is
 * what makes same-community nodes settle into the visible clusters of the
 * "communities" view (the look graphify/Obsidian produce) without pinning any
 * node to a fixed slot.
 */

export interface ClusterDatum {
  community: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

export interface ClusterForce {
  (alpha: number): void;
  initialize(nodes: ClusterDatum[]): void;
}

/** Mean position of each community's current members. */
export function communityCentroids(nodes: ClusterDatum[]): Map<number, { x: number; y: number }> {
  const acc = new Map<number, { x: number; y: number; n: number }>();
  for (const d of nodes) {
    const a = acc.get(d.community) ?? { x: 0, y: 0, n: 0 };
    a.x += d.x ?? 0;
    a.y += d.y ?? 0;
    a.n += 1;
    acc.set(d.community, a);
  }
  const out = new Map<number, { x: number; y: number }>();
  for (const [c, a] of acc) out.set(c, { x: a.x / a.n, y: a.y / a.n });
  return out;
}

export function clusterForce(strength: number): ClusterForce {
  let nodes: ClusterDatum[] = [];
  const force = ((alpha: number): void => {
    const centroids = communityCentroids(nodes);
    for (const d of nodes) {
      const c = centroids.get(d.community);
      if (!c) continue;
      d.vx = (d.vx ?? 0) + (c.x - (d.x ?? 0)) * strength * alpha;
      d.vy = (d.vy ?? 0) + (c.y - (d.y ?? 0)) * strength * alpha;
    }
  }) as ClusterForce;
  force.initialize = (n: ClusterDatum[]): void => {
    nodes = n;
  };
  return force;
}
