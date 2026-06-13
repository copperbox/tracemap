import { describe, expect, it } from 'vitest';
import { aggregateErrors, errorSignature, type ErrorSpanRow } from './errorSignature.js';

describe('errorSignature', () => {
  it('prefers a thrown exception type over everything else', () => {
    expect(
      errorSignature(
        {
          'exception.type': 'java.net.SocketTimeoutException',
          'exception.message': 'Read timed out',
          'error.type': '500',
          'http.response.status_code': 500,
        },
        500,
      ),
    ).toEqual({ code: 'java.net.SocketTimeoutException', message: 'Read timed out' });
  });

  it('falls back to the HTTP status when there is no exception type', () => {
    expect(errorSignature({ 'error.type': '503' }, 503)).toEqual({
      code: 'HTTP 503',
      message: 'Service Unavailable',
    });
  });

  it('uses the carried message for an HTTP status when present', () => {
    expect(
      errorSignature({ 'exception.message': 'upstream request timeout' }, 504),
    ).toEqual({ code: 'HTTP 504', message: 'upstream request timeout' });
  });

  it('reads the status from attrs when no column value is given', () => {
    expect(errorSignature({ 'http.response.status_code': 502 }, null)).toEqual({
      code: 'HTTP 502',
      message: 'Bad Gateway',
    });
  });

  it('uses a transport error.type when no exception or HTTP status exists', () => {
    expect(
      errorSignature(
        { 'error.type': 'REQUEST_TIMED_OUT', 'exception.message': 'The request timed out' },
        null,
      ),
    ).toEqual({ code: 'REQUEST_TIMED_OUT', message: 'The request timed out' });
  });

  it('falls back to a generic code when nothing identifying is present', () => {
    expect(errorSignature({}, null)).toEqual({ code: 'error', message: null });
  });
});

describe('aggregateErrors', () => {
  const row = (operation: string, attrs: Record<string, unknown>, httpStatus: number | null = null): ErrorSpanRow => ({
    operation,
    attrs,
    httpStatus,
  });

  it('groups by operation then by signature with counts', () => {
    const rows: ErrorSpanRow[] = [
      row('POST /v1/checkout', { 'error.type': '503' }, 503),
      row('POST /v1/checkout', { 'error.type': '503' }, 503),
      row('POST /v1/checkout', { 'exception.type': 'NullPointerException', 'exception.message': 'npe' }),
      row('GET /v1/cart', { 'error.type': '500' }, 500),
    ];
    const result = aggregateErrors(rows);

    expect(result).toHaveLength(2);
    // Busiest operation first.
    expect(result[0].operation).toBe('POST /v1/checkout');
    expect(result[0].errorCount).toBe(3);
    // Top signature within it is the repeated 503.
    expect(result[0].errors[0]).toEqual({ code: 'HTTP 503', message: 'Service Unavailable', count: 2 });
    expect(result[0].errors[1]).toEqual({ code: 'NullPointerException', message: 'npe', count: 1 });
    expect(result[1].operation).toBe('GET /v1/cart');
    expect(result[1].errorCount).toBe(1);
  });

  it('limits operations and signatures', () => {
    const rows: ErrorSpanRow[] = [];
    for (let op = 0; op < 8; op++) {
      for (let sig = 0; sig < 6; sig++) rows.push(row(`op-${op}`, { 'error.type': `code-${sig}` }));
    }
    const result = aggregateErrors(rows, 5, 4);
    expect(result).toHaveLength(5);
    for (const o of result) expect(o.errors.length).toBeLessThanOrEqual(4);
  });

  it('returns an empty list when there are no error spans', () => {
    expect(aggregateErrors([])).toEqual([]);
  });
});
