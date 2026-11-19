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

/** True when `inner` lies entirely inside `outer`. */
export function containsRect(outer: WorldRect, inner: WorldRect): boolean {
  return inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;
}

/** The world rect the mounted DOM layer was last built for, and at what zoom. */
export interface CullWindow {
  rect: WorldRect;
  k: number;
}

// Zoom drift tolerated before the mounted set is rebuilt. Zooming in keeps a
// window that is too big (more cards than needed); zooming out exposes its edge.
const RECULL_ZOOM_RATIO = 1.25;

/**
 * Whether the mounted set must be rebuilt for the current view: the visible
 * world rect has left the window, or the zoom drifted far enough that the
 * window is now much too large. Panning inside the window costs no render.
 */
export function needsRecull(win: CullWindow | null, visible: WorldRect, k: number): boolean {
  if (!win) return true;
  if (!containsRect(win.rect, visible)) return true;
  const ratio = k / win.k;
  return ratio > RECULL_ZOOM_RATIO || ratio < 1 / RECULL_ZOOM_RATIO;
}

/**
 * True when a card should be mounted: it overlaps the culling window, or it is
 * pinned in place by the user (selected, keyboard-focused, being dragged).
 * Unmounting a pinned card would drop focus or make a dragged card vanish.
 */
export function shouldMount(window: WorldRect, card: WorldRect, key: string, keep: ReadonlySet<string>): boolean {
  return keep.has(key) || rectsOverlap(window, card);
}
