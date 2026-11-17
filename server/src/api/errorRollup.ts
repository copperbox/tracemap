import type { ErrorCount, OperationErrors } from './errorSignature.js';

/** One error-rollup group: an operation and signature with its exact count. */
export interface ErrorRollupRow {
  operation: string;
  code: string;
  /** '' when the span carried no message (the column is NOT NULL). */
  message: string;
  n: number;
  /** 32-hex id of a kept trace showing this error, if any. */
  sample: string | null;
}

export interface ErrorCountWithSample extends ErrorCount {
  sampleTraceId?: string;
}

export interface OperationErrorsWithSamples extends Omit<OperationErrors, 'errors'> {
  errors: ErrorCountWithSample[];
}

/**
 * Group error rollups by operation, busiest first, each with its top
 * signatures. Counts are exact: an operation's errorCount includes signatures
 * beyond `sigLimit`.
 */
export function aggregateErrorRollups(rows: ErrorRollupRow[], opLimit = 5, sigLimit = 4): OperationErrorsWithSamples[] {
  const ops = new Map<string, { operation: string; errorCount: number; sigs: Map<string, ErrorCountWithSample> }>();
  for (const r of rows) {
    if (!(r.n > 0)) continue;
    let op = ops.get(r.operation);
    if (!op) {
      op = { operation: r.operation, errorCount: 0, sigs: new Map() };
      ops.set(r.operation, op);
    }
    op.errorCount += r.n;
    const key = r.code + '\u0001' + r.message;
    let e = op.sigs.get(key);
    if (!e) {
      e = { code: r.code, message: r.message === '' ? null : r.message, count: 0 };
      op.sigs.set(key, e);
    }
    e.count += r.n;
    if (r.sample && !e.sampleTraceId) e.sampleTraceId = r.sample;
  }
  return [...ops.values()]
    .sort((a, b) => b.errorCount - a.errorCount || a.operation.localeCompare(b.operation))
    .slice(0, opLimit)
    .map((o) => ({
      operation: o.operation,
      errorCount: o.errorCount,
      errors: [...o.sigs.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, sigLimit),
    }));
}
