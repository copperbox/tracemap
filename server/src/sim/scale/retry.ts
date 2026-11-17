/**
 * OTLP/HTTP retry rules for the load generator: 429, 502, 503 and 504 are
 * retryable and honor Retry-After; other 4xx are permanent; network errors
 * back off exponentially.
 */

export const MAX_ATTEMPTS = 5;
const MAX_DELAY_MS = 60_000;
const BASE_BACKOFF_MS = 500;

/** Retry-After as a delay in ms: delta-seconds or an HTTP date. Null when absent or unreadable. */
export function parseRetryAfter(value: string | string[] | undefined, nowMs = Date.now()): number | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (v == null || v.trim() === '') return null;
  const t = v.trim();
  if (/^\d+$/.test(t)) return Math.min(MAX_DELAY_MS, Number(t) * 1000);
  const at = Date.parse(t);
  if (Number.isNaN(at)) return null;
  return Math.min(MAX_DELAY_MS, Math.max(0, at - nowMs));
}

export type Decision =
  | { action: 'accepted' }
  | { action: 'retry'; delayMs: number }
  | { action: 'drop'; reason: string };

/**
 * What to do with a batch after attempt number `attempt` (1-based) ended with
 * `status` (null = network error).
 */
export function decide(status: number | null, retryAfter: string | string[] | undefined, attempt: number, nowMs = Date.now()): Decision {
  if (status != null && status >= 200 && status < 300) return { action: 'accepted' };
  const retryable = status == null || status === 429 || status === 502 || status === 503 || status === 504;
  if (!retryable) return { action: 'drop', reason: `HTTP ${status}` };
  if (attempt >= MAX_ATTEMPTS) return { action: 'drop', reason: `gave up after ${attempt} attempts` };
  const backoff = Math.min(MAX_DELAY_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  const hinted = status != null ? parseRetryAfter(retryAfter, nowMs) : null;
  return { action: 'retry', delayMs: hinted ?? backoff };
}
