import { describe, expect, it } from 'vitest';
import type { LiveStructure } from '../../api/types';
import { decodeFrame, encodeFrame } from './frame';
import { checkFrameMatches, flagStatus, isIngesting, mergeFrame } from './merge';

const svc = (id: string, extra: Partial<LiveStructure['services'][number]> = {}) => ({
  id,
  name: id.toUpperCase(),
  description: null,
  type: 'service',
  teamId: 1,
  runtime: 'node',
  region: null,
  isExternal: false,
  sloTarget: 99.9,
  sloAttain: 99.95,
  firstSeen: '2026-11-01T00:00:00.000Z',
  lastSeen: '2026-11-17T12:00:00.000Z',
  ...extra,
});

const edge = (s: number, t: number) => ({
  s,
  t,
  firstSeen: '2026-11-01T00:00:00.000Z',
  lastSeen: '2026-11-17T12:00:00.000Z',
  samples: 10,
  manual: false,
  confidence: 1,
});

const structure = (version: number, ids = ['a', 'b', 'c']): LiveStructure => ({
  version,
  generatedAt: '2026-11-17T12:00:00.000Z',
  teams: [{ id: 1, name: 'core' }],
  services: ids.map((id) => svc(id)),
  edges: [edge(0, 1), edge(1, 2)],
});

type Row = { values: (number | null)[]; flags: number };
const frame = (version: number, seq: number, services: Row[], edges: Row[]) =>
  decodeFrame(encodeFrame({ seq, structureVersion: version, generatedAtMs: 1_000_000 + seq, services, edges }));

const ok = (rps: number, p95: number | null = 10): Row => ({ values: [rps, 5, p95, 20, 0.5], flags: 0 });

describe('mergeFrame', () => {
  it('builds the Topology shape from structure and frame', () => {
    const st = structure(1);
    const f = frame(1, 1, [ok(10), { values: [null, null, null, null, null], flags: 0b101 }, ok(3)], [ok(1), ok(2)]);
    const { topology: t } = mergeFrame(st, f, null);
    expect(t.generatedAt).toBe(new Date(1_000_001).toISOString());
    expect(t.services.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(t.services[0]).toMatchObject({ name: 'A', teamId: 1, status: 'ok', sloAttain: 99.95 });
    expect(t.services[0].metrics).toEqual({ rps: 10, p50: 5, p95: 10, p99: 20, errPct: 0.5, stale: false });
    // NaN reads as null for latencies and 0 for rps / errPct.
    expect(t.services[1].metrics).toEqual({ rps: 0, p50: null, p95: null, p99: null, errPct: 0, stale: true });
    expect(t.services[1].status).toBe('crit');
    expect(t.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['a>b', 'b>c']);
    expect(t.edges[1].metrics.rps).toBe(2);
    expect(t.teams).toEqual([{ id: 1, name: 'core' }]);
  });

  it('keeps identity of unchanged entities and arrays under the same structure', () => {
    const st = structure(1);
    const first = mergeFrame(st, frame(1, 1, [ok(10), ok(20), ok(30)], [ok(1), ok(2)]), null);
    const second = mergeFrame(st, frame(1, 2, [ok(10), ok(21), ok(30)], [ok(1), ok(2)]), first);
    const [a1, b1, c1] = first.topology.services;
    const [a2, b2, c2] = second.topology.services;
    expect(a2).toBe(a1);
    expect(c2).toBe(c1);
    expect(b2).not.toBe(b1);
    expect(b2.metrics.rps).toBe(21);
    expect(second.topology.services).not.toBe(first.topology.services);
    // No edge changed, so the edges array itself is reused.
    expect(second.topology.edges).toBe(first.topology.edges);
    expect(second.topology.teams).toBe(first.topology.teams);
    // Values that did not change at all keep both arrays.
    const third = mergeFrame(st, frame(1, 3, [ok(10), ok(21), ok(30)], [ok(1), ok(2)]), second);
    expect(third.topology.services).toBe(second.topology.services);
    expect(third.topology.generatedAt).not.toBe(second.topology.generatedAt);
  });

  it('a status or stale flip alone makes a new object', () => {
    const st = structure(1);
    const first = mergeFrame(st, frame(1, 1, [ok(10), ok(20), ok(30)], [ok(1), ok(2)]), null);
    const warn = { ...ok(20), flags: 1 << 1 };
    const stale = { ...ok(1), flags: 1 };
    const second = mergeFrame(st, frame(1, 2, [ok(10), warn, ok(30)], [stale, ok(2)]), first);
    expect(second.topology.services[1].status).toBe('warn');
    expect(second.topology.services[1]).not.toBe(first.topology.services[1]);
    expect(second.topology.edges[0].metrics.stale).toBe(true);
    expect(second.topology.edges[1]).toBe(first.topology.edges[1]);
  });

  it('matches by id across a structure change and reuses what did not change', () => {
    const first = mergeFrame(structure(1), frame(1, 1, [ok(10), ok(20), ok(30)], [ok(1), ok(2)]), null);
    // New structure: service "b" renamed, a new service "d" inserted first.
    const st2 = structure(2, ['d', 'a', 'b', 'c']);
    st2.services[2] = svc('b', { name: 'Bee' });
    st2.edges = [edge(1, 2), edge(2, 3), edge(0, 1)];
    const second = mergeFrame(st2, frame(2, 2, [ok(5), ok(10), ok(20), ok(30)], [ok(1), ok(2), ok(9)]), first);
    const [d, a, b, c] = second.topology.services;
    expect(d.id).toBe('d');
    expect(a).toBe(first.topology.services[0]);
    expect(c).toBe(first.topology.services[2]);
    expect(b).not.toBe(first.topology.services[1]);
    expect(b.name).toBe('Bee');
    expect(second.topology.edges[0]).toBe(first.topology.edges[0]);
    expect(second.topology.edges[1]).toBe(first.topology.edges[1]);
    expect(second.topology.edges[2]).toMatchObject({ source: 'd', target: 'a' });
    expect(second.topology.teams).toBe(first.topology.teams);
  });

  it('reuses the arrays when a structure change touched nothing visible', () => {
    const first = mergeFrame(structure(1), frame(1, 1, [ok(10), ok(20), ok(30)], [ok(1), ok(2)]), null);
    const second = mergeFrame(structure(2), frame(2, 2, [ok(10), ok(20), ok(30)], [ok(1), ok(2)]), first);
    expect(second.topology.services).toBe(first.topology.services);
    expect(second.topology.edges).toBe(first.topology.edges);
  });
});

describe('checkFrameMatches', () => {
  it('rejects a frame for another structure version or with other counts', () => {
    const st = structure(3);
    expect(() => checkFrameMatches(st, frame(2, 1, [ok(1), ok(1), ok(1)], [ok(1), ok(1)]))).toThrow(/structure 2/);
    expect(() => checkFrameMatches(st, frame(3, 1, [ok(1), ok(1)], [ok(1), ok(1)]))).toThrow(/entities/);
    expect(() => checkFrameMatches(st, frame(3, 1, [ok(1), ok(1), ok(1)], [ok(1), ok(1)]))).not.toThrow();
  });
});

describe('flagStatus and isIngesting', () => {
  it('reads bits 1-2 and ignores the stale bit', () => {
    expect(flagStatus(0)).toBe('ok');
    expect(flagStatus(1)).toBe('ok');
    expect(flagStatus(2)).toBe('warn');
    expect(flagStatus(5)).toBe('crit');
    expect(flagStatus(7)).toBe('crit');
  });

  it('is ingesting only when a live service takes traffic', () => {
    const st = structure(1);
    const idle = mergeFrame(st, frame(1, 1, [ok(0), { ...ok(5), flags: 1 }, ok(0)], [ok(0), ok(0)]), null);
    expect(isIngesting(idle.topology)).toBe(false);
    const busy = mergeFrame(st, frame(1, 2, [ok(0), ok(5), ok(0)], [ok(0), ok(0)]), idle);
    expect(isIngesting(busy.topology)).toBe(true);
  });
});
