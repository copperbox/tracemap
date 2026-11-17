/**
 * How strongly healthy edges draw, given how many edges are on screen. A few
 * hundred lines read fine at full strength; thousands of green lines bury the
 * few amber and red ones a responder is looking for. The fade runs
 * log-linearly from 1 at FADE_START visible edges to FADE_FLOOR at FADE_END.
 */
export const FADE_START = 600;
export const FADE_END = 5000;
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
}

/**
 * Stroke for one edge under fade `fade`. Healthy edges fade (unless selected
 * or hovered); degraded and critical ones gain strength by as much, so the
 * thinner the healthy mesh gets the more the unhealthy edges stand out. At
 * fade 1 (a small fleet) every edge draws exactly as built.
 */
export function edgeStroke(
  v: { op: number; arrowOp: number; dim: boolean; isSel: boolean; isHov: boolean; e: { status: string } },
  fade: number,
): EdgeStroke {
  if (fade >= 1 || v.isSel || v.isHov) return { op: v.op, arrowOp: v.arrowOp, minPx: 0.6 };
  if (v.e.status === 'ok') return { op: v.op * fade, arrowOp: v.arrowOp * fade, minPx: 0.6 };
  if (v.dim) return { op: v.op, arrowOp: v.arrowOp, minPx: 0.6 };
  const boost = 1 - fade;
  return {
    op: v.op + (1 - v.op) * boost,
    arrowOp: v.arrowOp + (1 - v.arrowOp) * boost,
    minPx: 0.6 + 0.6 * boost,
  };
}
