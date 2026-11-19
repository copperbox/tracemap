import { describe, expect, it } from 'vitest';
import { TraceBuffer, type KeptSpanRow, type KeptTrace, type SpanInput, type TraceBufferOptions } from './traceBuffer.js';
import type { SigRef } from './cells.js';

const base: TraceBufferOptions = {
  decisionWaitMs: 10_000,
  maxAgeMs: 30_000,
  maxSpans: 10_000,
  maxSpansPerTrace: 100,
  errorQuota: 3,
  slowQuota: 2,
  baselineQuota: 1,
  keptSpansPerSec: 1000,
  decidedTtlMs: 60_000,
  decidedCapacity: 4096,
  initialBudgetSpans: 30_000,
};

class Sink {
  kept: KeptTrace[] = [];
  late: KeptSpanRow[] = [];
  room = Infinity;
  hasRoom(n: number) {
    return n <= this.room;
  }
  offer(t: KeptTrace) {
    this.kept.push(t);
  }
  offerLate(s: KeptSpanRow) {
    this.late.push(s);
    return true;
  }
}

let seq = 0;
const tid = (n: number) => n.toString(16).padStart(32, '0');
const sid = () => (++seq).toString(16).padStart(16, '0');

function span(traceId: string, over: Partial<SpanInput> = {}): SpanInput {
  return {
    traceId,
    spanId: sid(),
    parentSpanId: null,
    serviceId: 'gw',
    peerServiceId: null,
    name: 'GET /',
    kind: 2,
    startMs: 0,
    durationMs: 10,
    isError: false,
    isRoot: true,
    httpStatus: 200,
    attrs: { a: 1 },
    sigRef: null,
    rootOp: 'GET /',
    ...over,
  };
}

function setup(opts: Partial<TraceBufferOptions> = {}, p99 = Number.NaN) {
  const sink = new Sink();
  const samples: [SigRef, string][] = [];
  const buf = new TraceBuffer({ ...base, ...opts }, sink, {
    rootP99: () => p99,
    onErrorKeep: (ref, id) => samples.push([ref, id]),
  }, 0);
  return { sink, buf, samples };
}

const sig = (k = 'x'): SigRef => ({ kind: 'svc', minute: 0, mapKey: k });

describe('TraceBuffer decisions', () => {
  it('waits for quiet, then decides', () => {
    const { buf, sink } = setup();
    buf.add(span(tid(1)), 0);
    buf.sweep(9_999);
    expect(buf.stats(9_999).activeTraces).toBe(1);
    buf.sweep(10_000);
    expect(buf.stats(10_000).activeTraces).toBe(0);
    expect(sink.kept).toHaveLength(1);
    expect(sink.kept[0].reason).toBe('baseline');
  });

  it('decides a busy trace at max age', () => {
    const { buf } = setup();
    for (let t = 0; t <= 30_000; t += 5_000) buf.add(span(tid(1), { isRoot: false, parentSpanId: sid() }), t);
    buf.sweep(29_999);
    expect(buf.stats().activeTraces).toBe(1);
    buf.sweep(30_000);
    expect(buf.stats().decided).toBe(1);
  });

  it('keeps errors up to the per-signature quota, records the sample, then drops', () => {
    const { buf, sink, samples } = setup({ baselineQuota: 0 });
    for (let i = 0; i < 5; i++) buf.add(span(tid(i + 1), { isError: true, sigRef: sig() }), 0);
    buf.sweep(10_000);
    expect(sink.kept.map((k) => k.reason)).toEqual(['error', 'error', 'error']);
    expect(samples).toHaveLength(3);
    expect(buf.stats().dropped.notSelected).toBe(2);
  });

  it('keeps slow roots at or over p99, two per root op per minute', () => {
    const { buf, sink } = setup({ baselineQuota: 0 }, 100);
    for (let i = 0; i < 4; i++) buf.add(span(tid(i + 1), { durationMs: 150 }), 0);
    buf.add(span(tid(9), { durationMs: 50 }), 0);
    buf.sweep(10_000);
    expect(sink.kept.map((k) => k.reason)).toEqual(['slow', 'slow']);
  });

  it('keeps one baseline per root operation per minute', () => {
    const { buf, sink } = setup();
    for (let i = 0; i < 3; i++) buf.add(span(tid(i + 1)), 0);
    buf.add(span(tid(10), { name: 'POST /x', rootOp: 'POST /x' }), 0);
    buf.sweep(10_000);
    expect(sink.kept.map((k) => k.rootOperation)).toEqual(['GET /', 'POST /x']);
    // A new minute refreshes the quota.
    buf.add(span(tid(20)), 60_000);
    buf.sweep(70_000);
    expect(sink.kept).toHaveLength(3);
  });

  it('enforces the global span budget, and baseline only spends above half', () => {
    // 1 span/s budget: bucket holds 60, starts at 30.
    const { buf, sink } = setup({ keptSpansPerSec: 1, baselineShare: 0, errorQuota: 1000, initialBudgetSpans: 30 }, Number.NaN);
    for (let i = 0; i < 50; i++) buf.add(span(tid(i + 1), { isError: true, sigRef: sig() }), 0);
    buf.sweep(10_000); // 30 + 10 tokens accrued
    expect(sink.kept).toHaveLength(40);
    expect(buf.stats(10_000).dropped.budget).toBe(10);
    buf.add(span(tid(100)), 10_000);
    buf.sweep(20_000); // 10 tokens: under half, no baseline
    expect(sink.kept).toHaveLength(40);
  });

  it('reserves a share of the budget for baseline keeps under sustained error pressure', () => {
    // 100 spans/s, a quarter reserved: errors may keep 75/s, baselines get 25/s.
    const { buf, sink } = setup({ keptSpansPerSec: 100, baselineShare: 0.25, initialBudgetSpans: 0, errorQuota: 1e9, baselineQuota: 1e9 });
    let n = 0;
    for (let sec = 0; sec <= 600; sec++) {
      const at = sec * 1000;
      // Far more errors than the budget, and steady healthy traffic.
      for (let i = 0; i < 300; i++) buf.add(span(tid(++n), { isError: true, sigRef: sig() }), at);
      for (let i = 0; i < 50; i++) buf.add(span(tid(++n), { name: `op${i}`, rootOp: `op${i}` }), at);
      buf.sweep(at);
    }
    const counts = { error: 0, baseline: 0, slow: 0 };
    for (const k of sink.kept) counts[k.reason]++;
    // 600 s of budget, all spent, split 75/25 even though errors could use all of it.
    expect(sink.kept.length).toBeLessThanOrEqual(100 * 600);
    expect(counts.baseline).toBeGreaterThanOrEqual(25 * 590);
    expect(counts.baseline).toBeLessThanOrEqual(25 * 600);
    expect(counts.error).toBeGreaterThanOrEqual(75 * 590);
    expect(counts.error).toBeLessThanOrEqual(75 * 600);
  });

  it('lets baseline use the shared budget only while it is over half full', () => {
    const { buf, sink } = setup({ keptSpansPerSec: 4, baselineShare: 0.25, initialBudgetSpans: 240, baselineQuota: 1e9 });
    // Both buckets start full: reserve 60 (1/s), shared 180 (3/s).
    for (let i = 0; i < 200; i++) buf.add(span(tid(i + 1), { name: `op${i}`, rootOp: `op${i}` }), 0);
    buf.sweep(10_000);
    // All 60 of the reserve, then the shared bucket from 180 down to its half (90).
    expect(sink.kept).toHaveLength(60 + 90);
  });

  it('keeps quota keys apart when names contain a delimiter', () => {
    const { buf, sink } = setup();
    buf.add(span(tid(1), { serviceId: 'a|b', rootOp: 'c', name: 'c' }), 0);
    buf.add(span(tid(2), { serviceId: 'a', rootOp: 'b|c', name: 'b|c' }), 0);
    buf.sweep(10_000);
    expect(sink.kept).toHaveLength(2);
  });

  it('starts with an empty budget by default', () => {
    const { buf, sink } = setup({ initialBudgetSpans: undefined, errorQuota: 1000 });
    for (let i = 0; i < 3; i++) buf.add(span(tid(i + 1), { isError: true, sigRef: sig() }), 0);
    buf.sweep(10_000); // 10 s at 1000/s: plenty for three 1-span traces, but no baseline
    expect(sink.kept).toHaveLength(3);
    expect(buf.stats(10_000).budgetTokens).toBe(9_997);
  });

  it('does not keep when the writer queue is full', () => {
    const { buf, sink } = setup();
    sink.room = 0;
    buf.add(span(tid(1)), 0);
    buf.sweep(10_000);
    expect(sink.kept).toHaveLength(0);
    expect(buf.stats().dropped.queueFull).toBe(1);
  });
});

describe('TraceBuffer late spans and limits', () => {
  it('appends late spans of a kept trace and ignores those of a dropped one', () => {
    const { buf, sink } = setup({ baselineQuota: 1 });
    buf.add(span(tid(1)), 0);
    buf.add(span(tid(2)), 0); // same root op: no quota left, dropped
    buf.sweep(10_000);
    buf.add(span(tid(1), { isRoot: false, parentSpanId: sid() }), 11_000);
    buf.add(span(tid(2), { isRoot: false, parentSpanId: sid() }), 11_000);
    expect(sink.late).toHaveLength(1);
    const s = buf.stats();
    expect([s.lateKeptSpans, s.lateDroppedSpans, s.activeTraces]).toEqual([1, 1, 0]);
  });

  it('tracks new traces without bodies when full, and they cannot be kept', () => {
    const { buf, sink } = setup({ maxSpans: 2 });
    buf.add(span(tid(1)), 0);
    buf.add(span(tid(1), { isRoot: false, parentSpanId: sid() }), 0);
    buf.add(span(tid(2), { name: 'other', rootOp: 'other' }), 0);
    const s = buf.stats();
    expect([s.bufferedSpans, s.overflowTraces, s.activeTraces]).toEqual([2, 1, 2]);
    buf.sweep(10_000);
    expect(sink.kept).toHaveLength(1);
    expect(buf.stats().dropped.overflow).toBe(1);
    expect(buf.stats().bufferedSpans).toBe(0);
  });

  it('frees slots for reuse after decisions', () => {
    const { buf } = setup({ maxSpans: 10 });
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 10; i++) buf.add(span(tid(round * 100 + i + 1)), round * 20_000);
      buf.sweep(round * 20_000 + 10_000);
    }
    expect(buf.stats().overflowTraces).toBe(0);
    expect(buf.stats().bufferedSpans).toBe(0);
  });
});

describe('TraceBuffer materialization', () => {
  it('builds kept rows, fills unresolved callees from server spans, and lists services', () => {
    const { buf, sink } = setup();
    const t = tid(7);
    const root = span(t, { spanId: 'aaaaaaaaaaaaaaaa' });
    const call = span(t, {
      spanId: 'bbbbbbbbbbbbbbbb',
      parentSpanId: 'aaaaaaaaaaaaaaaa',
      kind: 3,
      isRoot: false,
      name: 'call orders',
      startMs: 2,
    });
    const handled = span(t, {
      spanId: 'cccccccccccccccc',
      parentSpanId: 'bbbbbbbbbbbbbbbb',
      serviceId: 'orders',
      isRoot: false,
      isError: true,
      name: 'GET /orders',
      startMs: 3,
      httpStatus: 503,
    });
    buf.add(root, 0);
    buf.add(call, 0);
    buf.add(handled, 0);
    buf.sweep(10_000);
    const k = sink.kept[0];
    expect(k).toMatchObject({ rootService: 'gw', rootOperation: 'GET /', hasError: true, durationMs: 10 });
    expect(k.spans).toHaveLength(3);
    const c = k.spans.find((s) => s.name === 'call orders')!;
    expect(c.peerServiceId).toBe('orders');
    expect([c.parentHi, c.parentLo]).toEqual([0xaaaaaaaa, 0xaaaaaaaa]);
    expect(k.spans[0].attrsJson).toBe('{"a":1}');
    expect(k.services.get('orders')).toEqual({ hasError: true, errorOps: new Set(['GET /orders']) });
    expect(k.services.get('gw')?.hasError).toBe(false);
  });
});
