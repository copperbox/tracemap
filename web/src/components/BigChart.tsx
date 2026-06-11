import { useState } from 'react';
import { fmtClock } from '../lib/format';
import { chartPath, chartY } from '../lib/spark';

const W = 560;
const H = 150;

export interface ChartSeries {
  label: string;
  /** Static color, or per-value color (error bars). */
  color: string | ((v: number) => string);
  values: (number | null)[];
  width?: number;
  opacity?: number;
}

/**
 * 150px chart from the design: optional gridlines, line/area/bar rendering,
 * crosshair hover with ring markers and a per-series tooltip that flips sides
 * past 58% of the chart width.
 */
export function BigChart({
  lines = [],
  area,
  bars,
  times,
  fmt,
  gridLines = 0,
  max,
}: {
  lines?: ChartSeries[];
  /** Render the first line with a gradient area fill (throughput chart). */
  area?: boolean;
  /** Bar series (error chart); rendered instead of lines when set. */
  bars?: ChartSeries;
  times: Date[];
  fmt: (v: number) => string;
  gridLines?: number;
  max?: number;
}) {
  const [frac, setFrac] = useState<number | null>(null);

  const all = bars ? [bars] : lines;
  const computedMax =
    max ??
    Math.max(
      1e-9,
      ...all.flatMap((s) => s.values.map((v) => v ?? 0)),
    );

  const n = all[0]?.values.length ?? 0;
  const colorOf = (s: ChartSeries, v: number): string => (typeof s.color === 'function' ? s.color(v) : s.color);

  let hover: {
    x: string;
    time: string;
    rows: { label: string; color: string; value: string }[];
    markers: { x: string; y: number; color: string }[];
  } | null = null;
  if (frac != null && n > 1) {
    const idx = Math.round(frac * (n - 1));
    const x = `${((idx / (n - 1)) * 100).toFixed(2)}%`;
    hover = {
      x,
      time: times[idx] ? fmtClock(times[idx]) : '',
      rows: all.map((s) => {
        const v = s.values[idx] ?? 0;
        return { label: s.label, color: colorOf(s, v), value: fmt(v) };
      }),
      markers: all.map((s) => {
        const v = s.values[idx] ?? 0;
        return {
          x,
          y: bars ? H - 6 - (v / computedMax) * (H - 26) : chartY(v, H, computedMax),
          color: colorOf(s, v),
        };
      }),
    };
  }

  const barW = 8;

  return (
    <div
      style={{ position: 'relative' }}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setFrac(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
      }}
      onMouseLeave={() => setFrac(null)}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: H, display: 'block' }}>
        {gridLines > 0 &&
          Array.from({ length: gridLines }, (_, i) => {
            const y = (14 + (i * (H - 36)) / (gridLines - 1)).toFixed(1);
            return <line key={i} x1="0" x2={W} y1={y} y2={y} stroke="var(--line)" strokeWidth="1" />;
          })}
        {area && lines[0] && (
          <>
            <defs>
              <linearGradient id="gThr" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" style={{ stopColor: 'var(--accent)', stopOpacity: 0.3 }} />
                <stop offset="1" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
              </linearGradient>
            </defs>
            <path d={`${chartPath(lines[0].values, W, H, computedMax)} L ${W} ${H} L 0 ${H} Z`} fill="url(#gThr)" stroke="none" />
          </>
        )}
        {!bars &&
          lines.map((s) => (
            <path
              key={s.label}
              d={chartPath(s.values, W, H, computedMax)}
              fill="none"
              stroke={typeof s.color === 'function' ? 'var(--accent)' : s.color}
              strokeWidth={s.width ?? 1.5}
              opacity={s.opacity ?? 1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        {bars &&
          bars.values.map((v, i) => {
            const val = v ?? 0;
            const h = Math.max(2, (val / computedMax) * (H - 26));
            return (
              <rect
                key={i}
                x={(i * (W / bars.values.length)).toFixed(1)}
                y={(H - 6 - h).toFixed(1)}
                width={barW}
                height={h.toFixed(1)}
                rx="1.5"
                fill={colorOf(bars, val)}
              />
            );
          })}
      </svg>
      {hover && (
        <>
          <div
            style={{
              position: 'absolute',
              top: 4,
              bottom: 4,
              left: hover.x,
              width: 1,
              background: 'var(--line2)',
              pointerEvents: 'none',
            }}
          />
          {hover.markers.map((m, i) => (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: m.x,
                top: m.y,
                width: 8,
                height: 8,
                border: `1.6px solid ${m.color}`,
                background: 'var(--bg2)',
                borderRadius: '50%',
                transform: 'translate(-50%,-50%)',
                pointerEvents: 'none',
              }}
            />
          ))}
          <div
            style={{
              position: 'absolute',
              top: 6,
              left: hover.x,
              transform: (frac ?? 0) > 0.58 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
              background: 'var(--bg2)',
              border: '1px solid var(--line2)',
              borderRadius: 8,
              padding: '7px 10px',
              pointerEvents: 'none',
              zIndex: 6,
              boxShadow: '0 10px 28px rgba(0,0,0,.35)',
              minWidth: 108,
            }}
          >
            <div style={{ font: "600 9px 'JetBrains Mono', monospace", color: 'var(--faint)', marginBottom: 4 }}>
              {hover.time}
            </div>
            {hover.rows.map((r) => (
              <div
                key={r.label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  font: "600 10px 'JetBrains Mono', monospace",
                  padding: '1.5px 0',
                }}
              >
                <span style={{ width: 8, height: 2, background: r.color, flex: 'none' }} />
                <span style={{ color: 'var(--dim)', fontWeight: 500 }}>{r.label}</span>
                <span style={{ flex: 1, minWidth: 10 }} />
                <span>{r.value}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
