/**
 * Shared hue scale for the trace waterfall and the community map.
 *
 * Hues are confined to a "safe" arc -- cyan -> blue -> violet -> magenta ->
 * pink -- that deliberately EXCLUDES red, amber/yellow, and green. Those hues
 * are reserved for state: error spans / critical status (red), degraded
 * (amber), and the selection/hover accent (green). Keeping fills out of those
 * bands means a service color can never be mistaken for an error.
 *
 * Within the arc, hues are spread by a golden-ratio low-discrepancy sequence,
 * so any number of services stays visually distinct without a fixed palette and
 * the assignment is deterministic per index. The community map colors by
 * community index and the trace waterfall by service index, but both draw from
 * this same scale, so the two views read as one palette.
 */
export type ThemeName = 'dark' | 'light';

// Start past green (~165) and stop before red (~350) so the whole band reads as
// cool/violet/pink -- never green, yellow, or red.
export const HUE_MIN = 192;
export const HUE_SPAN = 138; // -> up to 330 (magenta/pink)
const GOLDEN = 0.618033988749895;

/** Deterministic, well-spread hue (degrees) for the i-th item in the scale. */
export function paletteHue(index: number): number {
  const t = (((index * GOLDEN) % 1) + 1) % 1;
  return HUE_MIN + t * HUE_SPAN;
}

/** Concrete color for the i-th item, tuned per theme (hsl() works in CSS and canvas). */
export function paletteColor(index: number, theme: ThemeName): string {
  const hue = Math.round(paletteHue(index));
  return theme === 'light' ? `hsl(${hue}, 60%, 42%)` : `hsl(${hue}, 62%, 62%)`;
}

/**
 * Assign each service in a trace a distinct color from the scale. Services are
 * de-duplicated and sorted (so a service keeps its color across renders of the
 * same trace), then indexed into the golden-ratio sequence -- the actual set
 * present is maximally spread, with no fixed-palette collisions.
 */
export function buildSpanColors(serviceIds: Iterable<string>, theme: ThemeName): Map<string, string> {
  const ids = [...new Set(serviceIds)].sort();
  return new Map(ids.map((id, i) => [id, paletteColor(i, theme)]));
}
