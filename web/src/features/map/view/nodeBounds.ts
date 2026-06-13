import { NODE_H, NODE_W } from '../../../lib/layout';
import type { Pos } from '../../../lib/transition';

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Bounding box of NODE_W x NODE_H service cards at the given top-left
 * positions. Undefined entries (no known position) are skipped; returns null
 * when no positioned card remains.
 */
export function nodeCardBounds(points: (Pos | undefined)[]): Bounds | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (!p) continue;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + NODE_W);
    y1 = Math.max(y1, p.y + NODE_H);
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}
