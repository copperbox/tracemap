import type { Transform } from './usePanZoom';

/** Axis-aligned rectangle in world (pre-transform) coordinates. */
export interface WorldRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The world-space rectangle currently visible in a `viewW` x `viewH` canvas
 * under transform `tf`, grown by `margin` screen pixels on every side.
 *
 * Used to cull off-screen nodes/edges so the layered map only paints (and
 * hit-tests, and animates) what's on screen. The margin keeps a buffer of
 * just-offscreen elements mounted so small pans don't pop things in and out.
 *
 * Screen = world * k + t, so world = (screen - t) / k; the visible screen span
 * [-margin, view + margin] maps back to the world rect below.
 */
export function visibleWorldRect(tf: Transform, viewW: number, viewH: number, margin: number): WorldRect {
  const k = tf.k || 1;
  return {
    x0: (-margin - tf.tx) / k,
    y0: (-margin - tf.ty) / k,
    x1: (viewW + margin - tf.tx) / k,
    y1: (viewH + margin - tf.ty) / k,
  };
}

/** True when two axis-aligned rects overlap (shared edges count as overlap). */
export function rectsOverlap(a: WorldRect, b: WorldRect): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}
