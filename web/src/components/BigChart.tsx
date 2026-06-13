import { fmtClock } from '../lib/format';
import { chartPath, chartY, hoverIndex, hoverXPct } from '../lib/spark';
import { useHoverFrac } from './hoverSync';
import styles from './BigChart.module.css';

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
  const [frac, setFrac] = useHoverFrac();

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
    const idx = hoverIndex(frac, n);
    const x = hoverXPct(idx, n);
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
      className={styles.wrap}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setFrac(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
      }}
      onMouseLeave={() => setFrac(null)}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={styles.svg}>
        {gridLines > 0 &&
          Array.from({ length: gridLines }, (_, i) => {
            const y = (14 + (i * (H - 36)) / (gridLines - 1)).toFixed(1);
            return <line key={i} x1="0" x2={W} y1={y} y2={y} stroke="var(--line)" strokeWidth="1" />;
          })}
        {area && lines[0] && (
          <>
            <defs>
              <linearGradient id="gThr" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" className={styles.gradTop} />
                <stop offset="1" className={styles.gradBottom} />
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
          <div className={styles.crosshair} style={{ left: hover.x }} />
          {hover.markers.map((m, i) => (
            <div key={i} className={styles.marker} style={{ left: m.x, top: m.y, borderColor: m.color }} />
          ))}
          <div
            className={(frac ?? 0) > 0.58 ? `${styles.tooltip} ${styles.tooltipFlip}` : styles.tooltip}
            style={{ left: hover.x }}
          >
            <div className={styles.tooltipTime}>{hover.time}</div>
            {hover.rows.map((r) => (
              <div key={r.label} className={styles.tooltipRow}>
                <span className={styles.rowSwatch} style={{ background: r.color }} />
                <span className={styles.rowLabel}>{r.label}</span>
                <span className={styles.rowSpacer} />
                <span>{r.value}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
