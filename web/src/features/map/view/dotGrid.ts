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

// Floor so the grid never vanishes entirely at extreme zoom-out. Sits below the
// value the reachable min zoom (0.12) maps to, so it only guards, never brightens.
export const DOT_MIN_ALPHA = 0.05;

export function dotAlphaScale(k: number): number {
  const f = (k / DOT_REF_K) ** 2;
  return Math.max(DOT_MIN_ALPHA, Math.min(1, f));
}
