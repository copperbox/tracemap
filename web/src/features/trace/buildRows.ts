import type { TraceSpan } from '../../api/types';

export interface Row {
  span: TraceSpan;
  depth: number;
  startMs: number; // relative to trace start
}

/** Order spans as a tree (children under parents, sorted by start time). */
export function buildRows(spans: TraceSpan[]): { rows: Row[]; totalMs: number; t0: number } {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const children = new Map<string, TraceSpan[]>();
  const roots: TraceSpan[] = [];
  for (const s of spans) {
    if (s.parentSpanId && byId.has(s.parentSpanId)) {
      const arr = children.get(s.parentSpanId) ?? [];
      arr.push(s);
      children.set(s.parentSpanId, arr);
    } else {
      roots.push(s);
    }
  }
  const startOf = (s: TraceSpan) => new Date(s.startTime).getTime();
  roots.sort((a, b) => startOf(a) - startOf(b));
  const t0 = roots.length ? startOf(roots[0]) : 0;
  const rows: Row[] = [];
  const walk = (s: TraceSpan, depth: number) => {
    rows.push({ span: s, depth, startMs: startOf(s) - t0 });
    for (const c of (children.get(s.spanId) ?? []).sort((a, b) => startOf(a) - startOf(b))) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  const totalMs = Math.max(1, ...rows.map((r) => r.startMs + r.span.durationMs));
  return { rows, totalMs, t0 };
}
