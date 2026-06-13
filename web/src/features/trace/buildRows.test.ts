import { describe, expect, it } from 'vitest';
import type { TraceSpan } from '../../api/types';
import { buildRows } from './buildRows';

const T0 = '2026-06-12T10:00:00.000Z';

function span(overrides: Partial<TraceSpan> & { spanId: string }): TraceSpan {
  return {
    parentSpanId: null,
    serviceId: 'svc',
    name: overrides.spanId,
    kind: 1,
    startTime: T0,
    durationMs: 10,
    isError: false,
    attrs: {},
    ...overrides,
  };
}

const at = (offsetMs: number) => new Date(new Date(T0).getTime() + offsetMs).toISOString();

describe('buildRows', () => {
  it('handles an empty span list', () => {
    expect(buildRows([])).toEqual({ rows: [], totalMs: 1, t0: 0 });
  });

  it('nests children under parents with increasing depth', () => {
    const spans = [
      span({ spanId: 'root', durationMs: 100 }),
      span({ spanId: 'child', parentSpanId: 'root', startTime: at(10), durationMs: 30 }),
      span({ spanId: 'grandchild', parentSpanId: 'child', startTime: at(15), durationMs: 5 }),
    ];
    const { rows } = buildRows(spans);
    expect(rows.map((r) => [r.span.spanId, r.depth])).toEqual([
      ['root', 0],
      ['child', 1],
      ['grandchild', 2],
    ]);
  });

  it('sorts siblings by start time and computes offsets relative to trace start', () => {
    const spans = [
      span({ spanId: 'root', durationMs: 100 }),
      span({ spanId: 'late', parentSpanId: 'root', startTime: at(40), durationMs: 10 }),
      span({ spanId: 'early', parentSpanId: 'root', startTime: at(5), durationMs: 10 }),
    ];
    const { rows } = buildRows(spans);
    expect(rows.map((r) => r.span.spanId)).toEqual(['root', 'early', 'late']);
    expect(rows.map((r) => r.startMs)).toEqual([0, 5, 40]);
  });

  it('treats spans with unknown parents as roots', () => {
    const spans = [
      span({ spanId: 'orphan', parentSpanId: 'missing', startTime: at(20), durationMs: 10 }),
      span({ spanId: 'root', durationMs: 50 }),
    ];
    const { rows, t0 } = buildRows(spans);
    expect(rows.map((r) => [r.span.spanId, r.depth])).toEqual([
      ['root', 0],
      ['orphan', 0],
    ]);
    expect(t0).toBe(new Date(T0).getTime());
  });

  it('computes totalMs as the latest span end', () => {
    const spans = [
      span({ spanId: 'root', durationMs: 50 }),
      span({ spanId: 'tail', parentSpanId: 'root', startTime: at(40), durationMs: 35 }),
    ];
    expect(buildRows(spans).totalMs).toBe(75);
  });
});
