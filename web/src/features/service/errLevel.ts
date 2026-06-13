/**
 * Shared error-rate severity thresholds used by the error chart bars and the
 * operations table: above 2% is critical, above 0.8% is warning.
 */
export function errLevel(errPct: number | null | undefined): 'crit' | 'warn' | 'ok' {
  const v = errPct ?? 0;
  return v > 2 ? 'crit' : v > 0.8 ? 'warn' : 'ok';
}
