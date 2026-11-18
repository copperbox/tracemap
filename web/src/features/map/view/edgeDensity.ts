/**
 * How strongly healthy edges draw, given how many edges are on screen, at
 * every level of detail. A small fleet (the 40-service demo has 63 edges)
 * reads fine at full strength; past that, green lines crossing between and
 * behind cards bury the few amber and red ones a responder is looking for.
 * The fade runs log-linearly from 1 at FADE_START visible edges to
 * FADE_FLOOR at FADE_END.
 */
export const FADE_START = 120;
export const FADE_END = 2500;
export const FADE_FLOOR = 0.12;

export function healthyEdgeFade(visibleEdges: number): number {
  if (visibleEdges <= FADE_START) return 1;
  if (visibleEdges >= FADE_END) return FADE_FLOOR;
  const t = Math.log(visibleEdges / FADE_START) / Math.log(FADE_END / FADE_START);
  return Math.exp(t * Math.log(FADE_FLOOR));
}

export interface EdgeStroke {
  op: number;
  arrowOp: number;
  /** minimum line width in screen px */
  minPx: number;
  /** maximum line width in screen px (faded healthy edges stay hairlines when zoomed in), or null */
  maxPx: number | null;
}

/**
 * Stroke for one edge under fade `fade`. Healthy edges fade and stay one
 * screen pixel wide (unless selected or on the focus tree);
 * degraded and critical ones gain strength by as much, so the thinner the
 * healthy mesh gets the more the unhealthy edges stand out. At fade 1 (a
 * small fleet) every edge draws exactly as built.
 */
export function edgeStroke(
  v: {
    op: number;
    arrowOp: number;
    dim: boolean;
    isSel: boolean;
    focused?: boolean;
    e: { status: string };
  },
  fade: number,
): EdgeStroke {
  if (fade >= 1 || v.isSel || v.focused) return { op: v.op, arrowOp: v.arrowOp, minPx: 0.6, maxPx: null };
  if (v.e.status === 'ok') return { op: v.op * fade, arrowOp: v.arrowOp * fade, minPx: 0.6, maxPx: 1 };
  if (v.dim) return { op: v.op, arrowOp: v.arrowOp, minPx: 0.6, maxPx: null };
  const boost = 1 - fade;
  return {
    op: v.op + (1 - v.op) * boost,
    arrowOp: v.arrowOp + (1 - v.arrowOp) * boost,
    minPx: 0.6 + 0.6 * boost,
    maxPx: null,
  };
}
