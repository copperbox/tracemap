/**
 * Shared query-parameter parsing for API routes. `?from=&to=` are optional
 * ISO timestamps; the default window is the last 24 hours. Anything a route
 * would pass on to SQL is validated here, so bad input is a 400, never a
 * database error (500).
 */

const DAY_MS = 86_400_000;
/** Bounds for timestamps: the epoch to the year 9999 (Postgres and Date both handle these). */
const MIN_TIME_MS = 0;
const MAX_TIME_MS = Date.UTC(9999, 11, 31);
/** Longest range a chart may ask for: about three years of daily points. */
export const MAX_RANGE_MS = 1100 * DAY_MS;

export function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

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

/**
 * Parse the range, rejecting with a 400: a repeated or unparseable timestamp,
 * one outside 1970..9999, an empty or inverted range, or one longer than
 * MAX_RANGE_MS.
 */
export function parseRange(q: Record<string, unknown>): RangeMs {
  for (const k of ['from', 'to']) {
    if (q[k] != null && typeof q[k] !== 'string') throw badRequest('invalid time range');
  }
  const { fromMs, toMs } = rangeMs(q);
  const inBounds = (v: number) => Number.isFinite(v) && v >= MIN_TIME_MS && v <= MAX_TIME_MS;
  if (!inBounds(fromMs) || !inBounds(toMs) || fromMs >= toMs || toMs - fromMs > MAX_RANGE_MS) {
    throw badRequest('invalid time range');
  }
  return { fromMs, toMs };
}

/**
 * An optional integer parameter: `def` when absent, otherwise a base-10
 * integer in [min, max]. Fractions, exponents, signs, out-of-range values and
 * repeated parameters are a 400.
 */
export function parseIntParam(q: Record<string, unknown>, name: string, opts: { def: number; min: number; max: number }): number {
  const raw = q[name];
  if (raw == null || raw === '') return opts.def;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) throw badRequest(`${name} must be an integer from ${opts.min} to ${opts.max}`);
  const v = Number(raw);
  if (v < opts.min || v > opts.max) throw badRequest(`${name} must be an integer from ${opts.min} to ${opts.max}`);
  return v;
}
