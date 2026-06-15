import { afterEach, describe, expect, it } from 'vitest';
import { buildTopology, type TopologyConfig } from './genTopology.js';
import {
  BASE_ROOTS,
  BASE_SERVICES,
  byId,
  configureTopology,
  resetTopology,
  SERVICES,
} from './topology.js';
import { makeTrace, setRoots } from './trace.js';

const cfg = (over: Partial<TopologyConfig> = {}): TopologyConfig => ({
  services: 0,
  teams: 0,
  unassigned: 0,
  dupRatio: 0.4,
  seed: 1,
  ...over,
});

afterEach(() => {
  resetTopology();
  setRoots([]); // restore BASE_ROOTS
});

describe('buildTopology baseline', () => {
  it('returns the curated baseline untouched with no augmentation', () => {
    const t = buildTopology(cfg());
    expect(t.services).toHaveLength(BASE_SERVICES.length);
    expect(t.services.map((s) => s.id)).toContain('orders-svc');
    expect(t.unassigned).toHaveLength(0);
    expect(t.meta.syntheticServiceCount).toBe(0);
    expect(t.roots).toEqual(BASE_ROOTS);
  });

  it('weights always sum to ~1', () => {
    for (const services of [0, 120, 400]) {
      const sum = buildTopology(cfg({ services })).roots.reduce((a, [, w]) => a + w, 0);
      expect(sum).toBeCloseTo(1, 6);
    }
  });
});

describe('buildTopology augmentation', () => {
  it('grows to the requested total service count and keeps every curated node', () => {
    const t = buildTopology(cfg({ services: 200 }));
    expect(t.services).toHaveLength(200);
    expect(t.meta.syntheticServiceCount).toBe(200 - BASE_SERVICES.length);
    for (const s of BASE_SERVICES) expect(t.services.some((x) => x.id === s.id)).toBe(true);
  });

  it('produces unique service ids', () => {
    const ids = buildTopology(cfg({ services: 300 })).services.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('varies how many services each team owns', () => {
    const sizes = buildTopology(cfg({ services: 300 })).meta.teamSizes.map((t) => t.size);
    expect(sizes.length).toBeGreaterThan(1);
    expect(new Set(sizes).size).toBeGreaterThan(1); // not a uniform split
  });

  it('honors an explicit team count', () => {
    const t = buildTopology(cfg({ services: 200, teams: 6 }));
    expect(t.meta.teamSizes).toHaveLength(6);
  });

  it('is deterministic for a given seed', () => {
    const a = buildTopology(cfg({ services: 150, unassigned: 20, seed: 42 }));
    const b = buildTopology(cfg({ services: 150, unassigned: 20, seed: 42 }));
    expect(a.services.map((s) => s.id)).toEqual(b.services.map((s) => s.id));
    expect(a.unassigned.map((s) => s.id)).toEqual(b.unassigned.map((s) => s.id));
  });
});

describe('unassigned peers', () => {
  it('mints the requested count split into even duplicate pairs and singletons', () => {
    const t = buildTopology(cfg({ services: 120, unassigned: 20, dupRatio: 0.5 }));
    expect(t.unassigned).toHaveLength(20);
    expect(t.meta.dupPairs).toHaveLength(5); // floor(20 * 0.5 / 2)
    expect(t.meta.singletonUnassigned).toHaveLength(10);
  });

  it('keeps unassigned peers team-less and out of the seeded service catalog', () => {
    const t = buildTopology(cfg({ services: 120, unassigned: 16 }));
    const serviceIds = new Set(t.services.map((s) => s.id));
    for (const u of t.unassigned) {
      expect(u.team).toBe('');
      expect(serviceIds.has(u.id)).toBe(false);
    }
  });

  it('wires every duplicate pair as two distinct, reachable nodes', () => {
    const t = buildTopology(cfg({ services: 120, unassigned: 24, dupRatio: 1 }));
    const depTargets = new Set(Object.values(t.deps).flat());
    const peerIds = new Set(t.unassigned.map((u) => u.id));
    for (const [a, b] of t.meta.dupPairs) {
      expect(a).not.toBe(b);
      expect(peerIds.has(a) && peerIds.has(b)).toBe(true);
      expect(depTargets.has(a) && depTargets.has(b)).toBe(true);
    }
  });
});

describe('configureTopology wiring', () => {
  it('exposes unassigned peers through byId but not SERVICES, and resets cleanly', () => {
    const t = buildTopology(cfg({ services: 120, unassigned: 10, dupRatio: 1 }));
    const peerId = t.unassigned[0].id;
    configureTopology(t);
    expect(byId.has(peerId)).toBe(true);
    expect(SERVICES.some((s) => s.id === peerId)).toBe(false);
    resetTopology();
    expect(byId.has(peerId)).toBe(false);
    expect(SERVICES).toHaveLength(BASE_SERVICES.length);
  });

  it('drives traffic through synthetic teams once configured', () => {
    const t = buildTopology(cfg({ services: 200, seed: 7 }));
    const syntheticTeams = new Set(t.meta.teamSizes.map((x) => x.team));
    configureTopology(t);
    setRoots(t.roots);
    // A synthetic entry is any root that is not one of the curated baseline roots.
    const baseRootIds = new Set(BASE_ROOTS.map(([id]) => id));
    const entry = t.roots.find(([id]) => !baseRootIds.has(id))![0];
    let sawSynthetic = false;
    for (let i = 0; i < 25 && !sawSynthetic; i++) {
      sawSynthetic = makeTrace(Date.now(), entry).spans.some((s) => syntheticTeams.has(s.service.team));
    }
    expect(sawSynthetic).toBe(true);
  });
});
