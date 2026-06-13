/**
 * Evaluating positions along an edge's cubic bezier for the packet canvas.
 *
 * The browser's offset-path animation walks a path by ARC LENGTH, not by the
 * bezier parameter t (which bunches up on curves). To keep packets moving at a
 * steady visual speed we precompute a small arc-length lookup table per edge
 * once (per layout/drag frame), then map a 0..1 distance fraction to a point by
 * interpolating within it. All pure -- no SVG DOM, so it is unit-testable.
 */

import type { CubicCurve, Pt } from '../../../lib/edgeGeometry';

/** Point on the cubic at parameter t in [0, 1]. */
export function cubicAt(c: CubicCurve, t: number): Pt {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * c.a.x + w1 * c.c1.x + w2 * c.c2.x + w3 * c.b.x,
    y: w0 * c.a.y + w1 * c.c1.y + w2 * c.c2.y + w3 * c.b.y,
  };
}

/** Arc-length sampling of a cubic: sample points and their cumulative chord lengths. */
export interface ArcLut {
  pts: Pt[];
  /** cumulative chord length up to each sample (cum[0] === 0) */
  cum: number[];
  /** total polyline length */
  length: number;
}

/** Sample the cubic into a polyline arc-length table (default 24 segments). */
export function buildArcLut(c: CubicCurve, samples = 24): ArcLut {
  const n = Math.max(2, Math.floor(samples));
  const pts: Pt[] = [];
  const cum: number[] = [];
  let prev = cubicAt(c, 0);
  let len = 0;
  pts.push(prev);
  cum.push(0);
  for (let i = 1; i <= n; i++) {
    const p = cubicAt(c, i / n);
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    pts.push(p);
    cum.push(len);
    prev = p;
  }
  return { pts, cum, length: len };
}

/** Point at distance fraction s in [0, 1] along the arc-length table. */
export function pointAtFraction(lut: ArcLut, s: number): Pt {
  const { pts, cum, length } = lut;
  if (length <= 0) return pts[0];
  const target = Math.min(1, Math.max(0, s)) * length;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const f = (target - cum[i - 1]) / seg;
  const p0 = pts[i - 1];
  const p1 = pts[i];
  return { x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f };
}
