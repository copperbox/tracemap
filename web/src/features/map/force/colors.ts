/**
 * Per-community colors for the force graph.
 *
 * The hue scale itself (the cool->violet->pink "safe" arc, the golden-ratio
 * spread, and why red/amber/green are excluded) lives in lib/spanPalette.ts and
 * is shared with the trace waterfall, so the two views read as one palette.
 * Here a community is simply colored by its index into that scale.
 */
import { HUE_MIN, HUE_SPAN, paletteColor, paletteHue } from '../../../lib/spanPalette';

export { HUE_MIN, HUE_SPAN };

export const communityHue = paletteHue;

export function communityColor(index: number, theme: 'dark' | 'light'): string {
  return paletteColor(index, theme);
}
