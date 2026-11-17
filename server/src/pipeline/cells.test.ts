import { describe, expect, it } from 'vitest';
import { CellStore, splitEdgeKey } from './cells.js';
import { histTotal } from '../rollup/hist.js';

const opts = { graceMinutes: 3, liveMinutes: 5, maxOpsPerService: 2, maxErrorSigsPerService: 2 };
const T = 1_700_000_040_000; // some time; minute index below
const M = Math.floor(T / 60_000);

describe('CellStore clamping', () => {
  it('counts a span into its own minute inside the grace window', () => {
    const s = new CellStore(opts, 0);
    expect(s.minuteFor(T - 60_000, T)).toBe(M - 1);
    expect(s.minuteFor(T - 120_000, T)).toBe(M - 2);
    expect(s.counters).toEqual({ clampedPast: 0, clampedFuture: 0 });
  });

  it('clamps old spans into the oldest open minute and future spans into now', () => {
    const s = new CellStore(opts, 0);
    expect(s.minuteFor(T - 10 * 60_000, T)).toBe(M - 2);
    expect(s.minuteFor(T + 5 * 60_000, T)).toBe(M);
    expect(s.minuteFor(Number.NaN, T)).toBe(M - 2);
    expect(s.counters).toEqual({ clampedPast: 2, clampedFuture: 1 });
  });
});

describe('CellStore counting', () => {
  it('fills svc and op cells and caps distinct operations per service', () => {
    const s = new CellStore(opts, 0);
    s.addRequest(M, 'a', 'op1', 10, false, null);
    s.addRequest(M, 'a', 'op2', 20, true, { code: 'E', message: 'x' });
    const third = s.addRequest(M, 'a', 'op3', 30, false, null);
    expect(third.op).toBe('(other)');
    expect(s.addRequest(M, 'a', 'op1', 5, false, null).op).toBe('op1');
    const snap = s.takeDirty();
    const svc = snap.batches.find((b) => b.kind === 'svc_rollup')!;
    expect(svc.n).toEqual([4]);
    expect(svc.err).toEqual([1]);
    expect(svc.sumMs).toEqual([65]);
    expect(histTotal(svc.hist[0]!)).toBe(4);
    const op = snap.batches.find((b) => b.kind === 'op_rollup')!;
    expect(op.keys.map((k) => k[1]).sort()).toEqual(['(other)', 'op1', 'op2']);
    const err = snap.batches.find((b) => b.kind === 'svc_error_rollup')!;
    expect(err.keys).toEqual([['a', 'op2', 'E', 'x']]);
  });

  it('caps error signatures and truncates messages', () => {
    const s = new CellStore(opts, 0);
    const long = 'm'.repeat(500);
    s.addRequest(M, 'a', 'op', 1, true, { code: 'A', message: long });
    s.addRequest(M, 'a', 'op', 1, true, { code: 'B', message: null });
    s.addRequest(M, 'a', 'op', 1, true, { code: 'C', message: 'c' });
    const err = s.takeDirty().batches.find((b) => b.kind === 'svc_error_rollup')!;
    const keys = err.keys.map((k) => [k[2], k[3].length]);
    expect(keys).toContainEqual(['A', 200]);
    expect(keys).toContainEqual(['B', 0]);
    expect(keys).toContainEqual(['(other)', 0]);
  });

  it('fills edge, edge op and edge error cells', () => {
    const s = new CellStore(opts, 0);
    s.addEdge(M, 'a', 'b', 'GET', 10, false, null);
    const ref = s.addEdge(M, 'a', 'b', 'GET', 30, true, { code: 'HTTP 503', message: null });
    expect(ref?.kind).toBe('edge');
    s.setSample(ref!, 'f'.repeat(32));
    const snap = s.takeDirty();
    expect(snap.batches.find((b) => b.kind === 'edge_rollup')!.n).toEqual([2]);
    const eo = snap.batches.find((b) => b.kind === 'edge_op_rollup')!;
    expect([eo.n[0], eo.err[0]]).toEqual([2, 1]);
    const ee = snap.batches.find((b) => b.kind === 'edge_error_rollup')!;
    expect(ee.keys[0]).toEqual(['a', 'b', 'GET', 'HTTP 503', '']);
    expect(ee.sample[0]).toBe('f'.repeat(32));
  });
});

describe('CellStore flush cycle', () => {
  it('hands out only changed cells and restores them after a failed write', () => {
    const s = new CellStore(opts, 0);
    s.addRequest(M, 'a', 'op', 1, false, null);
    const first = s.takeDirty();
    expect(first.rows).toBe(2);
    expect(s.takeDirty().rows).toBe(0);
    s.restoreDirty(first);
    expect(s.takeDirty().rows).toBe(2);
    s.addRequest(M, 'b', 'op', 1, false, null);
    expect(s.takeDirty().rows).toBe(2);
  });

  it('finalizes closed minutes, keeps svc cells for the live window, then drops them', () => {
    const s = new CellStore(opts, 0);
    s.addRequest(M, 'a', 'op', 1, false, null);
    s.addEdge(M, 'a', 'b', 'op', 1, false, null);
    s.takeDirty();
    const later = (M + 3) * 60_000; // M has left the 3-minute grace window
    expect(s.backlogMinutes(later)).toBe(1);
    s.retire(later);
    expect(s.backlogMinutes(later)).toBe(0);
    expect(s.liveServices(later).entries.get('a')?.n).toBe(1);
    expect(s.cellCount()).toBe(2); // svc + edge kept, op cells freed
    s.retire((M + 6) * 60_000);
    expect(s.minuteCount).toBe(0);
  });

  it('keeps a closed minute with unwritten cells as backlog', () => {
    const s = new CellStore(opts, 0);
    s.addRequest(M, 'a', 'op', 1, false, null);
    s.retire((M + 10) * 60_000);
    expect(s.backlogMinutes((M + 10) * 60_000)).toBe(1);
  });
});

describe('CellStore live window', () => {
  it('sums the last N minutes and reports the covered seconds', () => {
    const s = new CellStore(opts, 0);
    s.addRequest(M - 1, 'a', 'op', 10, false, null);
    s.addRequest(M, 'a', 'op', 20, true, null);
    s.addEdge(M, 'a', 'b', 'op', 5, false, null);
    const now = M * 60_000 + 30_000;
    const w = s.liveServices(now);
    expect(w.entries.get('a')).toMatchObject({ n: 2, err: 1, sumMs: 30 });
    expect(w.seconds).toBe(4 * 60 + 30);
    const e = s.liveEdges(now);
    const [key] = [...e.entries.keys()];
    expect(splitEdgeKey(key)).toEqual(['a', 'b']);
  });

  it('does not claim time before the collector started', () => {
    const now = M * 60_000 + 30_000;
    const s = new CellStore(opts, now - 10_000);
    expect(s.liveServices(now).seconds).toBe(10);
  });
});
