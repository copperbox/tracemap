import type { CubicCurve, Pt } from '../../../lib/edgeGeometry';
import type { WorldRect } from './viewport';

/**
 * Where edge metric labels sit. A label goes on the first spot along its edge
 * (middle first, then outwards) where it covers no card, no team title bar
 * and no label placed before it. A label with no free spot is hidden, unless
 * its edge is selected or hovered: those always show, at the best spot found.
 */

export interface LabelRequest {
  key: string;
  curve: CubicCurve;
  /** label box size, world units */
  w: number;
  h: number;
  /** selected or hovered: placed even when every spot is covered */
  force: boolean;
}

/** Fractions along the edge to try, middle first. The ends sit inside cards. */
export const LABEL_TS = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82];
/** Clear space kept around a label, world units. */
const MARGIN = 3;
const CELL = 256;

export function bezierAt(c: CubicCurve, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return {
    x: a * c.a.x + b * c.c1.x + d * c.c2.x + e * c.b.x,
    y: a * c.a.y + b * c.c1.y + d * c.c2.y + e * c.b.y,
  };
}

/** Uniform grid of boxes for overlap queries. */
class BoxGrid {
  private cells = new Map<string, WorldRect[]>();

  add(r: WorldRect): void {
    for (let cx = Math.floor(r.x0 / CELL); cx <= Math.floor(r.x1 / CELL); cx++) {
      for (let cy = Math.floor(r.y0 / CELL); cy <= Math.floor(r.y1 / CELL); cy++) {
        const k = `${cx},${cy}`;
        const list = this.cells.get(k);
        if (list) list.push(r);
        else this.cells.set(k, [r]);
      }
    }
  }

  /** Overlapping area of `r` with the boxes in the grid (0 when free). */
  overlap(r: WorldRect, stopAtAny: boolean): number {
    let area = 0;
    const seen = new Set<WorldRect>();
    for (let cx = Math.floor(r.x0 / CELL); cx <= Math.floor(r.x1 / CELL); cx++) {
      for (let cy = Math.floor(r.y0 / CELL); cy <= Math.floor(r.y1 / CELL); cy++) {
        for (const o of this.cells.get(`${cx},${cy}`) ?? []) {
          if (seen.has(o)) continue;
          seen.add(o);
          const w = Math.min(r.x1, o.x1) - Math.max(r.x0, o.x0);
          const h = Math.min(r.y1, o.y1) - Math.max(r.y0, o.y0);
          if (w > 0 && h > 0) {
            area += w * h;
            if (stopAtAny) return area;
          }
        }
      }
    }
    return area;
  }
}

/**
 * Centers for the labels that show, keyed by request key. Forced labels are
 * placed first so they win their spot; the rest keep the given order.
 */
export function placeEdgeLabels(requests: LabelRequest[], obstacles: WorldRect[]): Map<string, Pt> {
  const grid = new BoxGrid();
  for (const o of obstacles) grid.add(o);
  const out = new Map<string, Pt>();
  const ordered = [...requests.filter((r) => r.force), ...requests.filter((r) => !r.force)];
  for (const req of ordered) {
    const boxAt = (p: Pt): WorldRect => ({
      x0: p.x - req.w / 2 - MARGIN,
      y0: p.y - req.h / 2 - MARGIN,
      x1: p.x + req.w / 2 + MARGIN,
      y1: p.y + req.h / 2 + MARGIN,
    });
    let chosen: Pt | null = null;
    let best: { p: Pt; area: number } | null = null;
    for (const t of LABEL_TS) {
      const p = bezierAt(req.curve, t);
      const area = grid.overlap(boxAt(p), !req.force);
      if (area === 0) {
        chosen = p;
        break;
      }
      if (req.force && (!best || area < best.area)) best = { p, area };
    }
    chosen ??= best?.p ?? null;
    if (!chosen) continue;
    out.set(req.key, chosen);
    grid.add(boxAt(chosen));
  }
  return out;
}

// Label box metrics (EdgeLabelLayer.module.css: 9.5 px JetBrains Mono, 2 px
// by 7 px padding, 1 px border). A monospace advance is 0.6 em.
const CHAR_W = 9.5 * 0.6;
const BOX_PAD_W = 2 * 7 + 2;
export const LABEL_BOX_H = 19;

/** Estimated label box width for `text`, world units. */
export function labelBoxWidth(text: string): number {
  return text.length * CHAR_W + BOX_PAD_W;
}
