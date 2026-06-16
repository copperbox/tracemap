import type { Transform, ViewBounds } from './usePanZoom';

// Below this zoom, node card text renders too small to read, so labels are
// hidden (cards become clean status-colored boxes) and a "zoom in" hint shows.
// Tuned to sit below where an isolated/compact subtree lands (~0.6-1.1, which
// must stay legible) but above the full-graph overview fit (~0.15, an unreadable
// blur), so only the genuinely illegible zooms drop their labels.
export const LABEL_MIN_K = 0.5;

// Zoom the camera reaches when centering on a single selected node: enough that
// the node's labels are legible. Centering never zooms OUT past this, only in.
export const CENTER_MIN_K = 0.9;

// Hard ceiling shared with usePanZoom's wheel/button zoom clamp.
const MAX_K = 2.4;

// Padding (screen px) and zoom clamp used when fitting bounds to the canvas.
// Shared by usePanZoom.fitBounds and the focus-cone legibility check so both
// agree on the zoom a given bounding box would land at.
export const FIT_PAD_X = 120;
export const FIT_PAD_Y = 150;
export const FIT_MIN_K = 0.12;
export const FIT_MAX_K = 1.1;

/**
 * The zoom `fitBounds` would use to fit world bounds `b` into a `viewW` x `viewH`
 * canvas: the largest scale that keeps the padded box on screen, clamped to
 * [FIT_MIN_K, FIT_MAX_K]. Exposed so callers can tell, before committing, whether
 * a fit would land legible or shrink to specks.
 */
export function fitZoom(b: ViewBounds, viewW: number, viewH: number): number {
  const bw = Math.max(1, b.x1 - b.x0);
  const bh = Math.max(1, b.y1 - b.y0);
  return Math.max(FIT_MIN_K, Math.min((viewW - FIT_PAD_X) / bw, (viewH - FIT_PAD_Y) / bh, FIT_MAX_K));
}

/**
 * Transform that centers world-space bounds `b` in a `viewW` x `viewH` canvas.
 *
 * Zoom is raised to at least `minK` so the target lands legible, but never
 * lowered below the current `curK` -- a user already zoomed in keeps their
 * detail and only pans. `rightInset` reserves screen pixels on the right (the
 * open drawer) so the centered node sits in the visible map area, not behind it.
 */
export function centerTransform(
  b: ViewBounds,
  viewW: number,
  viewH: number,
  curK: number,
  opts: { minK?: number; maxK?: number; rightInset?: number } = {},
): Transform {
  const minK = opts.minK ?? CENTER_MIN_K;
  const maxK = opts.maxK ?? MAX_K;
  const k = Math.min(maxK, Math.max(curK, minK));
  const availW = Math.max(1, viewW - (opts.rightInset ?? 0));
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  // screen = world * k + t  =>  put (cx, cy) at the center of the visible area.
  return { k, tx: availW / 2 - cx * k, ty: viewH / 2 - cy * k };
}
