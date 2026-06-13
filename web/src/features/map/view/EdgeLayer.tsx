import type { EdgeView } from './edgeViews';
import styles from './EdgeLayer.module.css';

/**
 * SVG layer with every edge: base path, animated flow dash, arrowhead, and a
 * fat invisible hit path for hover/click.
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
          <path
            d={v.d}
            fill="none"
            stroke={v.flowStroke}
            strokeWidth="1.7"
            opacity={v.flowOp}
            strokeDasharray="2.5 9.5"
            strokeLinecap="round"
            style={{ animation: `flow ${v.dur} linear infinite` }}
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
