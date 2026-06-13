import { describe, expect, it } from 'vitest';
import { clusterForce, communityCentroids, type ClusterDatum } from './clusterForce';

describe('communityCentroids', () => {
  it('averages each community independently', () => {
    const nodes: ClusterDatum[] = [
      { community: 0, x: 0, y: 0 },
      { community: 0, x: 10, y: 20 },
      { community: 1, x: 100, y: 100 },
    ];
    const c = communityCentroids(nodes);
    expect(c.get(0)).toEqual({ x: 5, y: 10 });
    expect(c.get(1)).toEqual({ x: 100, y: 100 });
  });
});

describe('clusterForce', () => {
  it('nudges a node toward its community centroid', () => {
    const nodes: ClusterDatum[] = [
      { community: 0, x: 0, y: 0, vx: 0, vy: 0 },
      { community: 0, x: 100, y: 0, vx: 0, vy: 0 },
    ];
    const force = clusterForce(0.5);
    force.initialize(nodes);
    force(1);
    // centroid is x=50; the node at 0 accelerates +x, the node at 100 accelerates -x.
    expect(nodes[0].vx).toBeGreaterThan(0);
    expect(nodes[1].vx).toBeLessThan(0);
    expect(nodes[0].vy).toBe(0);
  });

  it('does nothing before initialize', () => {
    const force = clusterForce(0.5);
    expect(() => force(1)).not.toThrow();
  });
});
