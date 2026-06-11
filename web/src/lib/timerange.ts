/** Kibana-style time range selection for the service detail page. */

export type TimeRange =
  | { kind: 'quick'; label: string; ms: number }
  | { kind: 'absolute'; from: number; to: number };

export const QUICK_RANGES: { label: string; ms: number }[] = [
  { label: 'Last 15 minutes', ms: 15 * 60_000 },
  { label: 'Last 1 hour', ms: 3_600_000 },
  { label: 'Last 3 hours', ms: 3 * 3_600_000 },
  { label: 'Last 12 hours', ms: 12 * 3_600_000 },
  { label: 'Last 24 hours', ms: 24 * 3_600_000 },
  { label: 'Last 3 days', ms: 3 * 86_400_000 },
  { label: 'Last 7 days', ms: 7 * 86_400_000 },
  { label: 'Last 30 days', ms: 30 * 86_400_000 },
];

export const DEFAULT_RANGE: TimeRange = { kind: 'quick', label: 'Last 24 hours', ms: 24 * 3_600_000 };

export function resolveRange(r: TimeRange, now = Date.now()): { from: Date; to: Date } {
  if (r.kind === 'quick') return { from: new Date(now - r.ms), to: new Date(now) };
  return { from: new Date(r.from), to: new Date(r.to) };
}

export function rangeLabel(r: TimeRange): string {
  if (r.kind === 'quick') return r.label;
  const f = new Date(r.from);
  const t = new Date(r.to);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${fmt(f)} \u2192 ${fmt(t)}`;
}

/** True when the range tracks "now" and should auto-refresh. */
export function isLiveRange(r: TimeRange): boolean {
  return r.kind === 'quick';
}
