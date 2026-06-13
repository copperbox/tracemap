import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { TraceDetail, TraceSpan } from '../../api/types';
import { CloseIcon } from '../../components/Icon';
import { DOT, fmtAgo, fmtMs } from '../../lib/format';
import { svcColor } from '../../lib/spanPalette';
import { useStore } from '../../state/store';

const mono = (px: number, weight = 500): string => `${weight} ${px}px 'JetBrains Mono', monospace`;

interface Row {
  span: TraceSpan;
  depth: number;
  startMs: number; // relative to trace start
}

/** Order spans as a tree (children under parents, sorted by start time). */
function buildRows(spans: TraceSpan[]): { rows: Row[]; totalMs: number; t0: number } {
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

export function TraceModal({ traceId }: { traceId: string }) {
  const openTrace = useStore((s) => s.openTrace);
  const theme = useStore((s) => s.theme);
  const [trace, setTrace] = useState<TraceDetail | null>(null);
  const [openSpan, setOpenSpan] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setTrace(null);
    setOpenSpan(null);
    api
      .trace(traceId)
      .then((t) => alive && setTrace(t))
      .catch((err) => alive && setError((err as Error).message));
    return () => {
      alive = false;
    };
  }, [traceId]);

  const built = useMemo(() => (trace ? buildRows(trace.spans) : null), [trace]);
  const close = () => openTrace(null);

  const hasError = trace?.spans.some((s) => s.isError) ?? false;
  const services = new Set(trace?.spans.map((s) => s.serviceId) ?? []);
  const firstStart = trace?.spans.length ? trace.spans[0].startTime : null;

  return (
    <div
      onClick={close}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(3,6,12,.62)',
        backdropFilter: 'blur(7px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(1080px, 94%)',
          maxHeight: '86%',
          background: 'var(--bg2)',
          border: '1px solid var(--line2)',
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: 'var(--shadow)',
          animation: 'fadeUp .25s ease',
        }}
      >
        <div style={{ padding: '15px 20px 13px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 14, flex: 'none' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ font: mono(8.5, 600), letterSpacing: '.16em', color: 'var(--faint)' }}>TRACE</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 3 }}>
              <span style={{ font: mono(14, 700), color: 'var(--accent)' }}>{traceId.slice(0, 16)}</span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '3px 9px',
                  borderRadius: 999,
                  background: hasError ? 'var(--critbg)' : 'var(--okbg)',
                  color: hasError ? 'var(--crit)' : 'var(--ok)',
                  font: mono(10, 600),
                }}
              >
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor' }} />
                {hasError ? 'ERROR' : 'OK'}
              </span>
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ font: mono(11), color: 'var(--dim)', textAlign: 'right' }}>
            {built
              ? `${fmtMs(built.totalMs)} total ${DOT} ${trace?.spans.length} spans ${DOT} ${services.size} services ${DOT} ${firstStart ? fmtAgo(firstStart) : '--'} ago`
              : error ?? 'loading\u2026'}
          </div>
          <div
            className="hov-btn"
            onClick={close}
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--faint)',
              border: '1px solid var(--line)',
            }}
          >
            <CloseIcon />
          </div>
        </div>

        <div style={{ display: 'flex', height: 26, borderBottom: '1px solid var(--line)', flex: 'none' }}>
          <div style={{ width: 300, flex: 'none', display: 'flex', alignItems: 'center', paddingLeft: 16, font: mono(8.5, 600), letterSpacing: '.14em', color: 'var(--faint)' }}>
            {`SPAN ${DOT} SERVICE`}
          </div>
          <div style={{ flex: 1, position: 'relative', borderLeft: '1px solid var(--line)' }}>
            {built &&
              Array.from({ length: 5 }, (_, i) => (
                <div key={i} style={{ position: 'absolute', top: 0, bottom: 0, left: `${i * 20}%`, borderLeft: '1px solid var(--line)' }}>
                  <div style={{ font: mono(8.5), color: 'var(--faint)', padding: '6px 0 0 5px', whiteSpace: 'nowrap' }}>
                    {fmtMs((built.totalMs * i) / 5)}
                  </div>
                </div>
              ))}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {built?.rows.map((r, i) => {
            const col = r.span.isError ? 'var(--crit)' : svcColor(r.span.serviceId, theme);
            const left = (r.startMs / built.totalMs) * 100;
            const width = Math.max(0.8, (r.span.durationMs / built.totalMs) * 100);
            const isOpen = openSpan === i;
            const attrs: [string, string][] = [
              ['span_id', r.span.spanId],
              ['service.name', r.span.serviceId],
              ['duration', fmtMs(r.span.durationMs)],
              ...Object.entries(r.span.attrs).map(
                ([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as [string, string],
              ),
              ['otel.status_code', r.span.isError ? 'ERROR' : 'OK'],
            ];
            return (
              <div
                key={r.span.spanId}
                onClick={() => setOpenSpan(isOpen ? null : i)}
                style={{ borderBottom: '1px solid var(--line)', cursor: 'pointer', background: isOpen ? 'var(--hoverbg)' : 'transparent' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', height: 30 }}>
                  <div style={{ width: 300, flex: 'none', display: 'flex', alignItems: 'center', gap: 7, paddingLeft: 16 + r.depth * 16, overflow: 'hidden' }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2.5, background: col, flex: 'none' }} />
                    <span style={{ font: mono(11, 600), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.span.name}</span>
                    <span style={{ font: mono(9), color: 'var(--faint)', whiteSpace: 'nowrap', flex: 'none' }}>{r.span.serviceId}</span>
                  </div>
                  <div style={{ flex: 1, position: 'relative', height: '100%', borderLeft: '1px solid var(--line)' }}>
                    <div
                      style={{
                        position: 'absolute',
                        top: 10,
                        height: 10,
                        borderRadius: 3,
                        left: `${left.toFixed(2)}%`,
                        width: `${width.toFixed(2)}%`,
                        background: `color-mix(in srgb, ${col} 30%, transparent)`,
                        border: `1px solid ${col}`,
                      }}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        top: 8.5,
                        left: left + width > 84 ? `calc(${left.toFixed(2)}% - 56px)` : `calc(${(left + width).toFixed(2)}% + 8px)`,
                        font: mono(9),
                        color: 'var(--dim)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {fmtMs(r.span.durationMs)}
                    </div>
                  </div>
                </div>
                {isOpen && (
                  <div style={{ padding: '8px 20px 12px 316px' }}>
                    {attrs.map(([key, val]) => (
                      <div key={key} style={{ display: 'flex', gap: 12, font: mono(10.5), padding: '2.5px 0' }}>
                        <span style={{ color: 'var(--faint)', width: 190, flex: 'none' }}>{key}</span>
                        <span style={{ wordBreak: 'break-all' }}>{val}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
