import { describe, expect, it } from 'vitest';
import type { Topology, TopologyService } from '../../../api/types';
import { LARGE_FLEET_SERVICES, planAutoCollapse, revealTeams, teamsReferenced } from './autoCollapse';

const svc = (id: string, teamId: number | null): TopologyService => ({
  id,
  name: id,
  description: null,
  type: 'service',
  teamId,
  runtime: null,
  region: null,
  isExternal: false,
  sloTarget: 99.9,
  sloAttain: null,
  firstSeen: '',
  lastSeen: '',
  status: 'ok',
  metrics: { rps: 1, p50: 1, p95: 1, p99: 1, errPct: 0, stale: false },
});

const fleet = (n: number): Topology => ({
  services: Array.from({ length: n }, (_, i) => svc(`s${i}`, (i % 3) + 1)),
  edges: [],
  teams: [
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
    { id: 3, name: 'c' },
  ],
  generatedAt: '',
});

describe('planAutoCollapse', () => {
  it('leaves a small fleet expanded', () => {
    expect(planAutoCollapse({ topology: fleet(LARGE_FLEET_SERVICES - 1), mergedTeams: [], keep: new Set() })).toBeNull();
  });

  it('collapses every team of a large fleet', () => {
    expect(planAutoCollapse({ topology: fleet(LARGE_FLEET_SERVICES), mergedTeams: [], keep: new Set() })).toEqual([1, 2, 3]);
  });

  it('keeps the teams a deep link points into expanded', () => {
    expect(planAutoCollapse({ topology: fleet(400), mergedTeams: [], keep: new Set([2]) })).toEqual([1, 3]);
  });

  it('respects a merge state the user already set', () => {
    expect(planAutoCollapse({ topology: fleet(400), mergedTeams: [3], keep: new Set() })).toBeNull();
  });

  it('respects an explicit expanded request', () => {
    expect(planAutoCollapse({ topology: fleet(400), mergedTeams: [], keep: new Set(), forceExpanded: true })).toBeNull();
  });
});

describe('teamsReferenced', () => {
  it('maps service and edge keys to their teams, skipping groups and unknowns', () => {
    const t = fleet(6);
    expect([...teamsReferenced(t, ['s1', 's3=>s5', 'group:1', 'nope', null])].sort()).toEqual([1, 2, 3]);
  });
});

describe('revealTeams', () => {
  it('expands the revealed teams', () => {
    expect(revealTeams([1, 2, 3], new Set([2]))).toEqual([1, 3]);
  });

  it('returns the same array when nothing changes', () => {
    const merged = [1, 3];
    expect(revealTeams(merged, new Set([2]))).toBe(merged);
    expect(revealTeams(merged, new Set())).toBe(merged);
  });
});
