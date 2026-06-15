import type { CubicCurve, EdgeGeometry, Pt } from '../../../lib/edgeGeometry';
import type { GraphEdge } from '../../../lib/grouping';

/** Everything the render layers need to draw one edge (path, arrow, label, animation). */
export interface EdgeView {
  e: GraphEdge;
  d: string;
  /** control points of `d`, for positioning packets along the edge on the canvas */
  curve: CubicCurve;
  dim: boolean;
  isSel: boolean;
  isHov: boolean;
  arrow: string;
  arrowFill: string;
  arrowOp: number;
  mid: Pt;
  stroke: string;
  w: number;
  op: number;
  flowStroke: string;
  flowOp: number;
  /** Glow color for the selected edge (status-tinted); null when not selected. */
  glow: string | null;
}

export function buildEdgeViews(
  edges: GraphEdge[],
  geoms: Map<string, EdgeGeometry>,
  opts: {
    dimmed: (key: string) => boolean;
    /**
     * When a focus is active, the keys of the edges actually on the focus tree.
     * An edge not in this set is dimmed even if both its endpoints are lit, so
     * cross-links between the upstream and downstream cones stay quiet. Null
     * (or omitted) when nothing is focused.
     */
    focusEdges?: Set<string> | null;
    selEdgeKey: string | null;
    hoverEdge: string | null;
    /** 1 normally; the eased 0..1 opacity for edges new in a structural transition. */
    fadeInOf: (key: string) => number;
  },
): EdgeView[] {
  return edges.flatMap((e) => {
    const g = geoms.get(e.key);
    if (!g) return [];
    const dimByNode = opts.dimmed(e.sourceKey) || opts.dimmed(e.targetKey);
    const dimByFocus = opts.focusEdges != null && !opts.focusEdges.has(e.key);
    const dim = dimByNode || dimByFocus;
    const isSel = opts.selEdgeKey === e.key;
    const isHov = opts.hoverEdge === e.key;
    const fadeIn = opts.fadeInOf(e.key);
    // Edge color follows health: green when healthy, amber/red when degraded or
    // critical. One hue drives the base stroke, the arrowhead and the packets, so
    // an edge reads as a single coherent color -- and the green now carries the
    // "healthy" signal that the animated flow dash (formerly the only green on
    // the line) used to provide before it was removed for performance.
    const color = e.status === 'crit' ? 'var(--crit)' : e.status === 'warn' ? 'var(--warn)' : 'var(--accent)';
    // Packets only animate while traces are actually arriving: an idle or stale
    // edge keeps its base path but goes quiet.
    const live = e.rps > 0 && !e.stale;
    return [
      {
        e,
        d: g.d,
        curve: g.curve,
        dim,
        isSel,
        isHov,
        arrow: g.arrow,
        arrowFill: color,
        arrowOp: (dim ? 0.04 : isSel || isHov ? 0.95 : e.status !== 'ok' ? 0.9 : 0.6) * fadeIn,
        mid: g.mid,
        stroke: color,
        w: isSel ? 2 : isHov ? 1.8 : 1.2,
        op: (dim ? 0.04 : isSel ? 0.95 : isHov ? 0.85 : e.status !== 'ok' ? 0.75 : 0.5) * fadeIn,
        flowStroke: color,
        flowOp: (dim || !live ? 0 : e.status !== 'ok' ? 0.95 : 0.7) * fadeIn,
        glow: isSel && !dim ? color : null,
      },
    ];
  });
}
