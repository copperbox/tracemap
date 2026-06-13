/**
 * Per-service colors for the trace waterfall. Each theme gets its own
 * palette: the dark theme uses bright pastels that read on near-black
 * panels, the light theme uses the same ten hues darkened so 30%-opacity
 * bar fills and 1px borders stay legible on white.
 */
export type ThemeName = 'dark' | 'light';

const DARK_PALETTE = [
  '#22D3EE', '#A78BFA', '#34D399', '#F472B6', '#FBBF24',
  '#60A5FA', '#2DD4BF', '#FB923C', '#C084FC', '#4ADE80',
];

const LIGHT_PALETTE = [
  '#0E7490', '#6D28D9', '#047857', '#BE185D', '#B45309',
  '#1D4ED8', '#0F766E', '#C2410C', '#7E22CE', '#15803D',
];

export const SPAN_PALETTES: Record<ThemeName, readonly string[]> = {
  dark: DARK_PALETTE,
  light: LIGHT_PALETTE,
};

/** Stable hash so a service keeps the same hue across themes and renders. */
export function svcColorIndex(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % DARK_PALETTE.length;
}

export function svcColor(id: string, theme: ThemeName): string {
  return SPAN_PALETTES[theme][svcColorIndex(id)];
}
