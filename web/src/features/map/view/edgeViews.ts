import type { CubicCurve, EdgeGeometry, Pt } from '../../../lib/edgeGeometry';
import type { GraphEdge } from '../../../lib/grouping';

/** Everything the render layers need to draw one edge (path, arrow, label, animation). */
export interface EdgeView {
  e: GraphEdge;
  /** control points, for drawing the edge and positioning packets along it */
  curve: CubicCurve;
  dim: boolean;
  isSel: boolean;
  /** on the focus tree while a focus is active */
  focused: boolean;
  /** 0..1 opacity factor while the edge fades in during a structural transition, else 1 */
  fadeIn: number;
  /** arrowhead points (tip first), for the canvas */
  arrowPts: [Pt, Pt, Pt];
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

export interface EdgeViewOptions {
  dimmed: (key: string) => boolean;
  /**
   * When a focus is active, the keys of the edges actually on the focus tree.
   * An edge not in this set is dimmed even if both its endpoints are lit, so
   * cross-links between the upstream and downstream cones stay quiet. Null
   * (or omitted) when nothing is focused.
   */
  focusEdges?: Set<string> | null;
  selEdgeKey: string | null;
  /** 1 normally; the eased 0..1 opacity for edges new in a structural transition. */
  fadeInOf: (key: string) => number;
}

/**
 * Hover is not an input: the hovered edge is highlighted on the overlay
 * canvas, so moving the pointer never rebuilds these.
 *
 * `prev` is the previous result. A view is reused when its edge object, its
 * geometry and its flags are unchanged, so a node drag (which moves a few
 * edges) or a selection (which changes two) allocates a handful of views
 * instead of one per edge.
 */
export function buildEdgeViews(
  edges: GraphEdge[],
  geoms: Map<string, EdgeGeometry>,
  opts: EdgeViewOptions,
  prev?: readonly EdgeView[],
): EdgeView[] {
  const out: EdgeView[] = [];
  let pi = 0;
  for (const e of edges) {
    const g = geoms.get(e.key);
    if (!g) continue;
    const dimByNode = opts.dimmed(e.sourceKey) || opts.dimmed(e.targetKey);
    const dimByFocus = opts.focusEdges != null && !opts.focusEdges.has(e.key);
    const dim = dimByNode || dimByFocus;
    const isSel = opts.selEdgeKey === e.key;
    const focused = opts.focusEdges != null && !dim;
    const fadeIn = opts.fadeInOf(e.key);
    // the previous view for this edge is almost always at the same position
    const old = prev?.[pi]?.e === e ? prev[pi] : undefined;
    pi++;
    if (old && old.curve === g.curve && old.dim === dim && old.isSel === isSel && old.focused === focused && old.fadeIn === fadeIn) {
      out.push(old);
      continue;
    }
    // Edge color follows health: green when healthy, amber/red when degraded or
    // critical. One hue drives the base stroke, the arrowhead and the packets, so
    // an edge reads as a single coherent color -- and the green now carries the
    // "healthy" signal that the animated flow dash (formerly the only green on
    // the line) used to provide before it was removed for performance.
    const color = e.status === 'crit' ? 'var(--crit)' : e.status === 'warn' ? 'var(--warn)' : 'var(--accent)';
    // Packets only animate while traces are actually arriving: an idle or stale
    // edge keeps its base path but goes quiet.
    const live = e.rps > 0 && !e.stale;
    out.push({
      e,
      curve: g.curve,
      dim,
      isSel,
      focused,
      fadeIn,
      arrowPts: g.arrowPts,
      arrowFill: color,
      arrowOp: (dim ? 0.04 : isSel ? 0.95 : e.status !== 'ok' ? 0.9 : 0.6) * fadeIn,
      mid: g.mid,
      stroke: color,
      w: isSel ? 2 : 1.2,
      op: (dim ? 0.04 : isSel ? 0.95 : e.status !== 'ok' ? 0.75 : 0.5) * fadeIn,
      flowStroke: color,
      flowOp: (dim || !live ? 0 : e.status !== 'ok' ? 0.95 : 0.7) * fadeIn,
      glow: isSel && !dim ? color : null,
    });
  }
  return out;
}
