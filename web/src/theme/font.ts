/**
 * Font shorthand helpers for the few places that build a CSS `font` value in
 * JS (canvas drawing, styles whose size or weight is computed at runtime).
 * Static font styles belong in the component's CSS module instead.
 */
export const mono = (px: number, weight = 500): string =>
  `${weight} ${px}px 'JetBrains Mono', monospace`;

export const sans = (px: number, weight = 500): string =>
  `${weight} ${px}px 'Space Grotesk', system-ui, sans-serif`;
