import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '../../../lib/grouping';
import { buildForceLinks, buildForceNodes, nodeRadius } from './forceNodes';

const node = (key: string, rps: number, community?: number): GraphNode => ({
  key,
  kind: 'service',
  serviceId: key,
  teamId: 1,
  label: key.toUpperCase(),
  type: 'service',
  status: 'ok',
  rps,
  p95: 50,
  errPct: 0,
  stale: false,
  isExternal: false,
  memberIds: [],
});

describe('nodeRadius', () => {
  it('floors quiet services and is monotonic in rps', () => {
    expect(nodeRadius(0)).toBe(5);
    expect(nodeRadius(100)).toBeGreaterThan(nodeRadius(10));
    expect(nodeRadius(10)).toBeGreaterThan(nodeRadius(0));
  });

  it('clamps very busy services to the max radius', () => {
    expect(nodeRadius(1e9)).toBe(26);
  });
});

describe('buildForceNodes', () => {
  it('carries the community id and a traffic-scaled radius', () => {
    const community = new Map([['a', 2]]);
    const [a] = buildForceNodes([node('a', 100)], community);
    expect(a.community).toBe(2);
    expect(a.r).toBe(nodeRadius(100));
  });

  it('defaults missing community ids to 0', () => {
    const [a] = buildForceNodes([node('a', 1)], new Map());
    expect(a.community).toBe(0);
  });
});

describe('buildForceLinks', () => {
  it('maps edge endpoint keys to source/target', () => {
    const edge: GraphEdge = {
      key: 'a=>b',
      sourceKey: 'a',
      targetKey: 'b',
      status: 'ok',
      rps: 1,
      p95: null,
      errPct: 0,
      stale: false,
      confidence: 90,
      samples: 10,
      underlying: [],
    };
    expect(buildForceLinks([edge])).toEqual([{ key: 'a=>b', source: 'a', target: 'b' }]);
  });
});
