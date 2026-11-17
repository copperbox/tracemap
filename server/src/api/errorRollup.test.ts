import { describe, expect, it } from 'vitest';
import { aggregateErrorRollups, type ErrorRollupRow } from './errorRollup.js';

const row = (operation: string, code: string, n: number, message = '', sample: string | null = null): ErrorRollupRow => ({
  operation,
  code,
  message,
  n,
  sample,
});

describe('aggregateErrorRollups', () => {
  it('groups by operation busiest first with exact totals beyond the signature limit', () => {
    const out = aggregateErrorRollups(
      [
        row('GET /a', 'HTTP 503', 40, 'Service Unavailable', 'abc'),
        row('GET /a', 'Timeout', 7),
        row('GET /a', 'E1', 1),
        row('GET /a', 'E2', 1),
        row('GET /a', 'E3', 1),
        row('POST /b', 'HTTP 500', 100, 'Internal Server Error'),
      ],
      5,
      4,
    );
    expect(out.map((o) => [o.operation, o.errorCount])).toEqual([
      ['POST /b', 100],
      ['GET /a', 50],
    ]);
    const a = out[1];
    expect(a.errors).toHaveLength(4);
    expect(a.errors[0]).toEqual({ code: 'HTTP 503', message: 'Service Unavailable', count: 40, sampleTraceId: 'abc' });
    expect(a.errors[1]).toEqual({ code: 'Timeout', message: null, count: 7 });
  });

  it('sums the same signature from several rows (aliases, tiers) and keeps a sample', () => {
    const out = aggregateErrorRollups([row('op', 'E', 2, 'm'), row('op', 'E', 3, 'm', 's1'), row('op', 'E', 1, 'm', 's2')]);
    expect(out).toEqual([{ operation: 'op', errorCount: 6, errors: [{ code: 'E', message: 'm', count: 6, sampleTraceId: 's1' }] }]);
  });

  it('keeps the overflow buckets as ordinary entries and ignores empty rows', () => {
    const out = aggregateErrorRollups([row('(other)', '(other)', 5), row('op', 'E', 0)]);
    expect(out).toEqual([{ operation: '(other)', errorCount: 5, errors: [{ code: '(other)', message: null, count: 5 }] }]);
    expect(aggregateErrorRollups([])).toEqual([]);
  });

  it('limits operations', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(`op${i}`, 'E', i + 1));
    expect(aggregateErrorRollups(rows, 3).map((o) => o.operation)).toEqual(['op7', 'op6', 'op5']);
  });
});
