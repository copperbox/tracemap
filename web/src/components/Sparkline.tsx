import { fmtClock } from '../lib/format';
import { hoverIndex, hoverXPct, sparkPath } from '../lib/spark';
import { useHoverFrac } from './hoverSync';
import styles from './Sparkline.module.css';

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
  const [frac, setFrac] = useHoverFrac();

  const n = data.length;
  let hover: { x: string; y: number; txt: string } | null = null;
  if (frac != null && n > 1) {
    const idx = hoverIndex(frac, n);
    const min = Math.min(...data);
    const max = Math.max(...data);
    const rng = max - min || 1;
    const time = times?.[idx];
    hover = {
      x: hoverXPct(idx, n),
      y: 26 - 3 - ((data[idx] - min) / rng) * (26 - 6),
      txt: `${time ? fmtClock(time) + ' \u00B7 ' : ''}${fmt(data[idx])}`,
    };
  }

  return (
    <div
      className={styles.wrap}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setFrac(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
      }}
      onMouseLeave={() => setFrac(null)}
    >
      <svg viewBox="0 0 120 26" preserveAspectRatio="none" className={styles.svg}>
        <path d={sparkPath(data)} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      {hover && (
        <>
          <div className={styles.crosshair} style={{ left: hover.x }} />
          {/* background falls back to var(--accent) in the module CSS when dotColor is unset */}
          <div className={styles.dot} style={{ left: hover.x, top: hover.y, background: dotColor }} />
          <div
            className={(frac ?? 0) > 0.55 ? `${styles.tooltip} ${styles.tooltipFlip}` : styles.tooltip}
            style={{ left: hover.x }}
          >
            {hover.txt}
          </div>
        </>
      )}
    </div>
  );
}
