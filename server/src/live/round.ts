/**
 * Output precision for metric numbers the API sends as JSON.
 *
 * Latency quantiles come from a histogram with 10% buckets, and rates and
 * percentages are shown with a few digits at most, so anything past 4
 * significant digits is noise that costs bytes (a 16-digit double prints as
 * 18 characters and barely compresses). Round only where response bodies are
 * built: stored data and threshold checks keep full precision. Counts and
 * timestamps are not passed through here.
 */

/** Powers of ten, exact as doubles up to 1e22. */
const POW10 = Array.from({ length: 23 }, (_, i) => Number(`1e${i}`));

/**
 * `v` rounded to 4 significant digits. 0, NaN and +-Infinity come back as
 * they are. The result is the double nearest the rounded decimal, so it
 * prints in at most 4 digits (plus exponent or leading zeros).
 */
export function sig4(v: number): number {
  if (v === 0 || !Number.isFinite(v)) return v;
  const a = Math.abs(v);
  // Digits to keep after the decimal point. log10 can be off by one at an
  // exact power of ten; that only keeps one digit more or less, never wrong.
  const k = 3 - Math.floor(Math.log10(a));
  if (k > 0) {
    if (k > 22) return Number(v.toPrecision(4));
    return Math.round(v * POW10[k]) / POW10[k];
  }
  if (-k > 22) return Number(v.toPrecision(4));
  return Math.round(v / POW10[-k]) * POW10[-k];
}

/** sig4 for nullable values. */
export function sig4OrNull(v: number | null): number | null {
  return v == null ? null : sig4(v);
}

/** The five live numbers with output precision; other fields pass through. */
export function roundMetrics<T extends { rps: number; p50: number | null; p95: number | null; p99: number | null; errPct: number }>(m: T): T {
  return { ...m, rps: sig4(m.rps), p50: sig4OrNull(m.p50), p95: sig4OrNull(m.p95), p99: sig4OrNull(m.p99), errPct: sig4(m.errPct) };
}
