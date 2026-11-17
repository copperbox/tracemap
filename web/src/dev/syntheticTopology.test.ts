import { describe, expect, it } from 'vitest';
import { generateTopology, refreshMetrics, statusOf } from './syntheticTopology';

describe('generateTopology', () => {
  const { topology, baseline } = generateTopology(1000);

  it('produces the requested size with unique ids', () => {
    expect(topology.services).toHaveLength(1000);
    expect(new Set(topology.services.map((s) => s.id)).size).toBe(1000);
  });

  it('has teams and team-less inferred peers', () => {
    expect(topology.teams.length).toBeGreaterThan(50);
    const peers = topology.services.filter((s) => s.teamId == null);
    expect(peers.length).toBeGreaterThan(30);
    expect(peers.every((s) => s.isExternal)).toBe(true);
    expect(new Set(peers.map((s) => s.type))).toEqual(new Set(['external', 'postgres', 'kafka', 'redis']));
  });

  it('has a realistic fan-out between 1.5 and 2.2 edges per service', () => {
    const ratio = topology.edges.length / topology.services.length;
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(2.2);
  });

  it('only connects known services, without self or duplicate edges', () => {
    const ids = new Set(topology.services.map((s) => s.id));
    const keys = new Set<string>();
    for (const e of topology.edges) {
      expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
      expect(e.source).not.toBe(e.target);
      keys.add(`${e.source}=>${e.target}`);
    }
    expect(keys.size).toBe(topology.edges.length);
  });

  it('runs some services hot', () => {
    const warn = topology.services.filter((s) => s.status === 'warn').length;
    const crit = topology.services.filter((s) => s.status === 'crit').length;
    expect(warn).toBeGreaterThan(10);
    expect(crit).toBeGreaterThan(2);
    expect(warn + crit).toBeLessThan(200);
  });

  it('is deterministic for a size and seed', () => {
    const again = generateTopology(1000).topology;
    expect(again.services.map((s) => s.id)).toEqual(topology.services.map((s) => s.id));
    expect(again.edges.length).toBe(topology.edges.length);
  });

  it('refreshes some metrics and keeps the rest identical', () => {
    const next = refreshMetrics(topology, baseline, 1, 0.5);
    const changed = next.services.filter((s, i) => s !== topology.services[i]).length;
    expect(changed).toBeGreaterThan(300);
    expect(changed).toBeLessThan(700);
    expect(next.services.map((s) => s.id)).toEqual(topology.services.map((s) => s.id));
    for (const s of next.services) expect(s.status).toBe(statusOf(s.metrics.errPct));
  });
});
