import { describe, expect, it } from 'vitest';
import type { ServiceList, ServiceListItem, TopologyService } from '../api/types';
import { mergeExtras, rankServiceRows, serviceRow } from './serviceRows';

const svc = (id: string, status: TopologyService['status'], rps: number, teamId: number | null = 1): TopologyService => ({
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
  status,
  metrics: { rps, p50: null, p95: null, p99: null, errPct: 0, stale: false },
});

const item = (id: string, spark: number[], sloAttain: number | null = 99.9): ServiceListItem => ({
  id,
  name: id,
  type: 'service',
  teamId: 1,
  runtime: null,
  isExternal: false,
  sloTarget: 99.9,
  sloAttain,
  lastSeen: '',
  status: 'ok',
  rps: 0,
  p95: null,
  errPct: 0,
  spark,
});
const list = (...services: ServiceListItem[]): ServiceList => ({ edgeCount: 0, services });

describe('serviceRow', () => {
  it('returns the same row for the same service object', () => {
    const s = svc('a', 'ok', 1);
    expect(serviceRow(s)).toBe(serviceRow(s));
    expect(serviceRow({ ...s })).not.toBe(serviceRow(s));
  });

  it('ranks by live status then rps, with search and team filter', () => {
    const services = [svc('a', 'ok', 50), svc('b', 'crit', 1), svc('c', 'ok', 90, 2), svc('d', 'warn', 5)];
    expect(rankServiceRows(services, '', 'all').map((r) => r.id)).toEqual(['b', 'd', 'c', 'a']);
    expect(rankServiceRows(services, 'c', 'all').map((r) => r.id)).toEqual(['c']);
    expect(rankServiceRows(services, '', 2).map((r) => r.id)).toEqual(['c']);
  });
});

describe('mergeExtras', () => {
  it('keeps entries and spark arrays whose data did not change', () => {
    const first = mergeExtras(null, list(item('a', [1, 2, 3]), item('b', [4, 5])));
    const second = mergeExtras(first, list(item('a', [1, 2, 3]), item('b', [4, 6])));
    expect(second.get('a')).toBe(first.get('a'));
    expect(second.get('b')).not.toBe(first.get('b'));
    expect(second.get('b')!.spark).toEqual([4, 6]);
  });

  it('keeps the spark array when only the SLO changed', () => {
    const first = mergeExtras(null, list(item('a', [1, 2], 99.9)));
    const second = mergeExtras(first, list(item('a', [1, 2], 99.5)));
    expect(second.get('a')).not.toBe(first.get('a'));
    expect(second.get('a')!.spark).toBe(first.get('a')!.spark);
    expect(second.get('a')!.sloAttain).toBe(99.5);
  });

  it('drops services that left the list', () => {
    const first = mergeExtras(null, list(item('a', [1]), item('b', [2])));
    expect([...mergeExtras(first, list(item('b', [2]))).keys()]).toEqual(['b']);
  });
});
