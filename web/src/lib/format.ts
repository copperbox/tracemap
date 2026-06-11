export const DOT = '\u00B7';
export const ARROW = '\u2192';
export const ELLIPSIS = '\u2026';
export const MINUS = '\u2212';

export function fmtRps(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '--';
  return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v));
}

export function fmtMs(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '--';
  return v >= 1000 ? (v / 1000).toFixed(2) + 's' : v >= 100 ? Math.round(v) + 'ms' : v.toFixed(1) + 'ms';
}

export function fmtCount(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '--';
  return v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'k' : String(Math.round(v));
}

export function fmtErr(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '--';
  return v.toFixed(v < 1 ? 2 : 1) + '%';
}

export function fmtClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Deterministic display jitter so live values gently tick (design behavior). */
export function jit(key: string, tick: number, amp = 0.05): number {
  let ph = 0;
  for (let i = 0; i < key.length; i++) ph += key.charCodeAt(i);
  return 1 + amp * Math.sin(tick * 0.8 + ph);
}
