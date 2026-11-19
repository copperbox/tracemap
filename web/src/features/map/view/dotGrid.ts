// The canvas backdrop is a single fixed-size dot (a radial-gradient ~1.4px
// across) tiled every 22*k screen px, so the grid scales with the world. The
// dot itself does NOT scale, so as k shrinks (zooming out) the same dots pack
// closer together: the pattern's ink coverage -- and therefore its apparent
// brightness -- climbs as ~1/k^2. That makes a far-out view read much brighter
// than the same backdrop up close.
//
// Scaling each dot's alpha by (k/ref)^2 below a reference zoom cancels that
// 1/k^2 growth, holding perceived brightness constant so the background keeps
// the same dark tone at every zoom. At or above the reference we leave the dots
// fully opaque, so the close-up look (which already reads correctly) is
// unchanged. Consumed by the canvas as the `--dot-k` custom property; see the
// radial-gradient in MapView/ForceGraph CSS.

// Zoom at/above which dots render at full strength. Matches the default camera
// scale (usePanZoom initial k), so normal and zoomed-in views are untouched and
// only the genuinely-too-bright zoomed-out range is dimmed.
export const DOT_REF_K = 0.5;

// Floor so the grid never vanishes entirely at extreme zoom-out.
export const DOT_MIN_ALPHA = 0.05;

export function dotAlphaScale(k: number): number {
  const f = (k / DOT_REF_K) ** 2;
  return Math.max(DOT_MIN_ALPHA, Math.min(1, f));
}

/** World spacing of the backdrop dots, in px at zoom 1. */
export const DOT_PITCH = 22;
/** Smallest on-screen tile the backdrop may use. */
export const DOT_MIN_TILE_PX = 11;

/**
 * On-screen tile size for the dot backdrop at zoom k: the world pitch scaled
 * by k, doubled until it is at least DOT_MIN_TILE_PX. Without the doubling a
 * far zoom tiles sub-pixel gradients across the canvas, which costs far more
 * to paint than the whole map. Doubling keeps the dots on world positions.
 */
export function dotTilePx(k: number): number {
  let t = DOT_PITCH * k;
  if (!(t > 0)) return DOT_PITCH;
  while (t < DOT_MIN_TILE_PX) t *= 2;
  return t;
}
