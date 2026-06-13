/** SVG path helpers matching the design prototype's chart geometry. */

export function sparkPath(arr: number[], w = 120, h = 26): string {
  if (arr.length < 2) return '';
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  const rng = max - min || 1;
  return arr
    .map((v, i) => {
      const x = (i / (arr.length - 1)) * w;
      const y = h - 3 - ((v - min) / rng) * (h - 6);
      return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    })
    .join(' ');
}

export function chartPath(arr: (number | null)[], w: number, h: number, max?: number): string {
  const vals = arr.map((v) => v ?? 0);
  if (vals.length < 2) return '';
  const m = max ?? Math.max(...vals, 1);
  return vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * w;
      const y = h - 8 - (v / (m || 1)) * (h - 26);
      return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    })
    .join(' ');
}

export function chartY(v: number, h: number, max: number): number {
  return h - 8 - (v / (max || 1)) * (h - 26);
}

/** Data index under a hover fraction (0-1 across the chart width). */
export function hoverIndex(frac: number, n: number): number {
  return Math.round(frac * (n - 1));
}

/** CSS left% for the crosshair, snapped to the hovered data point. */
export function hoverXPct(idx: number, n: number): string {
  return `${((idx / (n - 1)) * 100).toFixed(2)}%`;
}
