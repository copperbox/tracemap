import type { EdgeView } from './edgeViews';
import styles from './EdgeLayer.module.css';

/**
 * SVG layer with every edge: base path, arrowhead, and a fat invisible hit path
 * for hover/click.
 *
 * There is deliberately no animated flow dash here. A scrolling
 * `stroke-dashoffset` animation is not GPU-compositable, so it forces a full
 * SVG repaint every frame whose cost grows with zoom -- with ~100 services it
 * dropped the zoomed-in map to <10fps. Flow and direction are already conveyed
 * by the arrowhead and the glowing packets on PacketCanvas (a screen-space
 * canvas that stays cheap at any zoom), so the dash was pure cost.
 */
export function EdgeLayer({
  edges,
  onSelect,
  onHover,
  wasDrag,
}: {
  edges: EdgeView[];
  onSelect: (key: string) => void;
  onHover: (key: string | null) => void;
  /** Clicks at the end of a drag are ignored. */
  wasDrag: () => boolean;
}) {
  return (
    <svg width="8000" height="3000" className={styles.svg}>
      {edges.map((v) => (
        <g key={v.e.key}>
          <path
            d={v.d}
            fill="none"
            stroke={v.stroke}
            strokeWidth={v.w}
            opacity={v.op}
            style={v.glow ? { filter: `drop-shadow(0 0 5px ${v.glow})` } : undefined}
          />
          <polygon points={v.arrow} fill={v.arrowFill} opacity={v.arrowOp} />
          <path
            d={v.d}
            fill="none"
            stroke="rgba(0,0,0,0)"
            strokeWidth="16"
            className={styles.hit}
            onClick={(ev) => {
              ev.stopPropagation();
              if (!wasDrag()) onSelect(v.e.key);
            }}
            onMouseEnter={() => onHover(v.e.key)}
            onMouseLeave={() => onHover(null)}
          />
        </g>
      ))}
    </svg>
  );
}
