import type { CubicCurve, Pt } from '../../../lib/edgeGeometry';
import { cubicAt } from './packetPath';
import type { WorldRect } from './viewport';

/**
 * Hit-testing for the canvas map: which node or edge sits under a world-space
 * point. A linear scan with a bounding-box reject is under a millisecond for
 * thousands of items, runs at most once per animation frame (hover) or per
 * click, and needs no index to build or invalidate, so the first interaction
 * after a layout change is as cheap as any other.
 */

export interface RectItem {
  key: string;
  rect: WorldRect;
}

/** Last item (the one drawn on top) whose rect, grown by `pad`, holds the point. */
export function hitRect(items: readonly RectItem[], x: number, y: number, pad = 0): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const r = items[i].rect;
    if (x >= r.x0 - pad && x <= r.x1 + pad && y >= r.y0 - pad && y <= r.y1 + pad) return items[i].key;
  }
  return null;
}

/** Squared distance from point p to segment ab. */
export function distSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len > 0 ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/** A cubic flattened to a polyline (`samples` segments). */
export function flattenCubic(c: CubicCurve, samples = 12): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= samples; i++) pts.push(cubicAt(c, i / samples));
  return pts;
}

// Per-curve bounding box (the control points' hull contains the curve) and
// flattened polyline. Curves keep their identity until geometry changes.
const boxes = new WeakMap<CubicCurve, WorldRect>();
const lines = new WeakMap<CubicCurve, Pt[]>();

export function curveBox(c: CubicCurve): WorldRect {
  let b = boxes.get(c);
  if (!b) {
    b = {
      x0: Math.min(c.a.x, c.b.x, c.c1.x, c.c2.x),
      y0: Math.min(c.a.y, c.b.y, c.c1.y, c.c2.y),
      x1: Math.max(c.a.x, c.b.x, c.c1.x, c.c2.x),
      y1: Math.max(c.a.y, c.b.y, c.c1.y, c.c2.y),
    };
    boxes.set(c, b);
  }
  return b;
}

/** Distance from a point to a curve (via its cached polyline). */
export function distToCurve(c: CubicCurve, x: number, y: number): number {
  let pts = lines.get(c);
  if (!pts) {
    pts = flattenCubic(c);
    lines.set(c, pts);
  }
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = distSqToSegment(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Nearest edge within `tol` world units of the point. */
export function hitEdge(
  edges: readonly { key: string; curve: CubicCurve }[],
  x: number,
  y: number,
  tol: number,
): string | null {
  let best: string | null = null;
  let bestD = tol;
  for (const e of edges) {
    const b = curveBox(e.curve);
    if (x < b.x0 - tol || x > b.x1 + tol || y < b.y0 - tol || y > b.y1 + tol) continue;
    const d = distToCurve(e.curve, x, y);
    if (d <= bestD) {
      bestD = d;
      best = e.key;
    }
  }
  return best;
}
