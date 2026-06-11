import { useState } from 'react';
import { fmtClock } from '../lib/format';
import { sparkPath } from '../lib/spark';

/**
 * 26px sparkline with the drawer hover behavior from the design:
 * vertical crosshair, dot on the line, small "HH:MM <value>" tooltip that
 * flips sides past 55% width.
 */
export function Sparkline({
  data,
  times,
  color,
  fmt,
  dotColor,
}: {
  data: number[];
  times?: Date[];
  color: string;
  fmt: (v: number) => string;
  dotColor?: string;
}) {
  const [frac, setFrac] = useState<number | null>(null);

  const n = data.length;
  let hover: { x: string; y: number; txt: string } | null = null;
  if (frac != null && n > 1) {
    const idx = Math.round(frac * (n - 1));
    const min = Math.min(...data);
    const max = Math.max(...data);
    const rng = max - min || 1;
    const time = times?.[idx];
    hover = {
      x: `${((idx / (n - 1)) * 100).toFixed(2)}%`,
      y: 26 - 3 - ((data[idx] - min) / rng) * (26 - 6),
      txt: `${time ? fmtClock(time) + ' \u00B7 ' : ''}${fmt(data[idx])}`,
    };
  }

  return (
    <div
      style={{ flex: 1, position: 'relative' }}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setFrac(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
      }}
      onMouseLeave={() => setFrac(null)}
    >
      <svg viewBox="0 0 120 26" preserveAspectRatio="none" style={{ width: '100%', height: 26, display: 'block' }}>
        <path d={sparkPath(data)} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      {hover && (
        <>
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: hover.x,
              width: 1,
              background: 'var(--line2)',
              pointerEvents: 'none',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: hover.x,
              top: hover.y,
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: dotColor ?? 'var(--accent)',
              transform: 'translate(-50%,-50%)',
              pointerEvents: 'none',
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: -32,
              left: hover.x,
              transform: (frac ?? 0) > 0.55 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)',
              background: 'var(--bg2)',
              border: '1px solid var(--line2)',
              borderRadius: 6,
              padding: '4px 8px',
              font: "600 9.5px 'JetBrains Mono', monospace",
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              zIndex: 6,
              boxShadow: '0 6px 18px rgba(0,0,0,.3)',
            }}
          >
            {hover.txt}
          </div>
        </>
      )}
    </div>
  );
}
