/**
 * Per-community colors for the force graph.
 *
 * Hues are confined to a "safe" arc -- cyan -> blue -> violet -> magenta ->
 * pink -- that deliberately EXCLUDES red, amber/yellow, and green. Those hues
 * are reserved for node state: the status rings (degraded = amber, critical =
 * red) and the selection/hover accent (green). Keeping community fills out of
 * those bands means a community color can never be mistaken for a node's
 * status outline.
 *
 * Within the arc, hues are spread by a golden-ratio low-discrepancy sequence,
 * so any number of communities stays visually distinct without a fixed palette
 * and the assignment is deterministic per community id. Returned as comma-form
 * hsl() strings, which every canvas 2d context accepts as a fillStyle.
 */

// Start past green (which runs to ~165) and stop before red (~350), so the
// whole band reads as cool/violet/pink -- never green, yellow, or red.
export const HUE_MIN = 192;
export const HUE_SPAN = 138; // -> up to 330 (magenta/pink)
const GOLDEN = 0.618033988749895;

export function communityHue(index: number): number {
  const t = ((index * GOLDEN) % 1 + 1) % 1;
  return HUE_MIN + t * HUE_SPAN;
}

export function communityColor(index: number, theme: 'dark' | 'light'): string {
  const hue = Math.round(communityHue(index));
  return theme === 'light' ? `hsl(${hue}, 60%, 42%)` : `hsl(${hue}, 62%, 62%)`;
}
