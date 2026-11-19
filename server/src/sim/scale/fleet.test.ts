import { describe, expect, it } from 'vitest';
import { hostLabel, inferPeer } from '../../otlp/infer.js';
import { clientAttrs } from './batch.js';
import { buildFleet, type Fleet } from './fleet.js';

const shape = (f: Fleet) => ({
  ids: f.nodes.map((n) => n.id),
  edges: f.edges.map((e) => `${e.s}>${e.t}:${e.ops.join('|')}:${e.p}`),
  err: f.nodes.map((n) => n.opErr.join(',')),
  health: f.nodes.map((n) => n.health),
  incidents: f.incidents,
});

describe('buildFleet', () => {
  const fleet = buildFleet({ services: 2000, teams: 0, seed: 1 });

  it('is deterministic for the same services, teams and seed', () => {
    expect(shape(buildFleet({ services: 2000, teams: 0, seed: 1 }))).toEqual(shape(fleet));
  });

  it('changes with the seed and with the team count', () => {
    expect(shape(buildFleet({ services: 2000, teams: 0, seed: 2 })).ids).not.toEqual(shape(fleet).ids);
    expect(buildFleet({ services: 2000, teams: 20, seed: 1 }).teams).toHaveLength(20);
  });

  it('has exactly the requested node count with unique ids', () => {
    expect(fleet.nodes).toHaveLength(2000);
    expect(new Set(fleet.nodes.map((n) => n.id)).size).toBe(2000);
    expect(buildFleet({ services: 5000, teams: 0, seed: 1 }).nodes).toHaveLength(5000);
  });

  it('has teams of varied size', () => {
    const sizes = new Map<number, number>();
    for (const n of fleet.nodes) if (n.team != null) sizes.set(n.team, (sizes.get(n.team) ?? 0) + 1);
    const v = [...sizes.values()];
    expect(Math.max(...v)).toBeGreaterThan(3 * Math.min(...v));
  });

  it('is a layered DAG: calls go deeper or to peers, peers call nothing', () => {
    for (const e of fleet.edges) {
      const s = fleet.nodes[e.s];
      const t = fleet.nodes[e.t];
      expect(s.instrumented).toBe(true);
      expect(t.layer).toBeGreaterThan(s.layer);
    }
    for (const n of fleet.nodes) if (!n.instrumented) expect(fleet.out[n.idx]).toHaveLength(0);
  });

  it('gives every non-gateway node a caller and every instrumented node some ops', () => {
    for (const n of fleet.nodes) {
      if (n.type !== 'gateway') expect(fleet.inbound[n.idx].length).toBeGreaterThan(0);
      if (n.instrumented) expect(n.ops.length).toBeGreaterThan(0);
    }
  });

  it('includes inferred peers of several kinds and a few unhealthy services', () => {
    const types = new Set(fleet.nodes.filter((n) => !n.instrumented).map((n) => n.type));
    for (const t of ['postgres', 'redis', 'kafka', 's3', 'external']) expect(types).toContain(t);
    expect(fleet.nodes.some((n) => n.health === 'crit')).toBe(true);
    expect(fleet.nodes.some((n) => n.health === 'warn')).toBe(true);
    const unhealthy = fleet.nodes.filter((n) => n.health !== 'ok').length;
    expect(unhealthy / fleet.nodes.length).toBeLessThan(0.03);
    expect(fleet.incidents.length).toBeGreaterThanOrEqual(3);
  });

  it('addresses every callee so the collector infers the same id', () => {
    const internal = new Set(fleet.nodes.filter((n) => n.instrumented).map((n) => n.id));
    for (const e of fleet.edges) {
      const t = fleet.nodes[e.t];
      const attrs = Object.fromEntries(clientAttrs(t, e.ops[0]));
      const guess = inferPeer(attrs, (id) => internal.has(id));
      expect(guess?.id, `${t.type} ${t.id}`).toBe(t.id);
      expect(guess?.isExternal).toBe(!t.instrumented);
    }
    expect(hostLabel(fleet.nodes.find((n) => n.type === 'postgres')!.host)).not.toContain('.');
  });
});
