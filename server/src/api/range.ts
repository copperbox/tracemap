/**
 * Shared `?from=&to=` time-range parsing for API routes. Both ends are
 * optional ISO timestamps; the default window is the last 24 hours.
 */

export interface RangeMs {
  fromMs: number;
  toMs: number;
}

/** Parse the range without validating it (NaN for unparseable timestamps). */
export function rangeMs(q: Record<string, unknown>): RangeMs {
  const toMs = q.to ? Date.parse(String(q.to)) : Date.now();
  const fromMs = q.from ? Date.parse(String(q.from)) : toMs - 24 * 3600 * 1000;
  return { fromMs, toMs };
}

/** Parse the range, rejecting unparseable or inverted ranges with a 400. */
export function parseRange(q: Record<string, unknown>): RangeMs {
  const { fromMs, toMs } = rangeMs(q);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw Object.assign(new Error('invalid time range'), { statusCode: 400 });
  }
  return { fromMs, toMs };
}
