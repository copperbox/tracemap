import { describe, expect, it } from 'vitest';
import type { TopologyService } from '../api/types';
import { servicesByStatus } from './healthSummary';

function svc(
  id: string,
  status: TopologyService['status'],
  metrics: Partial<TopologyService['metrics']> = {},
): TopologyService {
  return {
    id,
    name: id,
    description: null,
    type: 'service',
    teamId: null,
    runtime: null,
    region: null,
    isExternal: false,
    sloTarget: 99.9,
    sloAttain: 99.8,
    firstSeen: '2026-01-01T00:00:00Z',
    lastSeen: '2026-01-01T00:00:00Z',
    status,
    metrics: { rps: 0, p50: null, p95: null, p99: null, errPct: 0, stale: false, ...metrics },
  };
}

const SERVICES: TopologyService[] = [
  svc('healthy-a', 'ok', { errPct: 0 }),
  svc('crit-low', 'crit', { errPct: 2, p95: 100 }),
  svc('crit-high', 'crit', { errPct: 9, p95: 800 }),
  svc('warn-a', 'warn', { errPct: 1, p95: 300 }),
  svc('healthy-b', 'ok', { errPct: 0 }),
];

describe('servicesByStatus', () => {
  it('returns only services in the requested status', () => {
    expect(servicesByStatus(SERVICES, 'crit').map((s) => s.id)).toEqual(['crit-high', 'crit-low']);
    expect(servicesByStatus(SERVICES, 'warn').map((s) => s.id)).toEqual(['warn-a']);
    expect(servicesByStatus(SERVICES, 'ok').map((s) => s.id)).toEqual(['healthy-a', 'healthy-b']);
  });

  it('sorts worst-first by error rate', () => {
    const ids = servicesByStatus(SERVICES, 'crit').map((s) => s.id);
    expect(ids[0]).toBe('crit-high');
  });

  it('breaks error-rate ties with tail latency then name', () => {
    const tied = [
      svc('b-fast', 'crit', { errPct: 5, p95: 100 }),
      svc('a-slow', 'crit', { errPct: 5, p95: 900 }),
      svc('c-fast', 'crit', { errPct: 5, p95: 100 }),
    ];
    expect(servicesByStatus(tied, 'crit').map((s) => s.id)).toEqual(['a-slow', 'b-fast', 'c-fast']);
  });

  it('treats a null p95 as lowest latency in the tie-break', () => {
    const tied = [
      svc('has-p95', 'warn', { errPct: 3, p95: 200 }),
      svc('no-p95', 'warn', { errPct: 3, p95: null }),
    ];
    expect(servicesByStatus(tied, 'warn').map((s) => s.id)).toEqual(['has-p95', 'no-p95']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(servicesByStatus([svc('ok-only', 'ok')], 'crit')).toEqual([]);
  });
});
