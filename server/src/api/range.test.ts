import { describe, expect, it } from 'vitest';
import { parseIntParam, parseRange, rangeMs } from './range.js';

describe('rangeMs', () => {
  it('parses explicit from/to ISO timestamps', () => {
    const r = rangeMs({ from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' });
    expect(r.fromMs).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(r.toMs).toBe(Date.parse('2026-01-02T00:00:00Z'));
  });

  it('defaults to the 24 hours ending now', () => {
    const before = Date.now();
    const r = rangeMs({});
    const after = Date.now();
    expect(r.toMs).toBeGreaterThanOrEqual(before);
    expect(r.toMs).toBeLessThanOrEqual(after);
    expect(r.toMs - r.fromMs).toBe(24 * 3600 * 1000);
  });

  it('anchors the default window to an explicit to', () => {
    const r = rangeMs({ to: '2026-01-02T00:00:00Z' });
    expect(r.fromMs).toBe(r.toMs - 24 * 3600 * 1000);
  });

  it('passes unparseable timestamps through as NaN (no validation)', () => {
    const r = rangeMs({ from: 'not-a-date' });
    expect(Number.isNaN(r.fromMs)).toBe(true);
  });
});

describe('parseRange', () => {
  it('returns the same values as rangeMs for valid input', () => {
    const q = { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' };
    expect(parseRange(q)).toEqual(rangeMs(q));
  });

  it('rejects unparseable from with a 400', () => {
    expect(() => parseRange({ from: 'garbage' })).toThrowError('invalid time range');
    try {
      parseRange({ from: 'garbage' });
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(400);
    }
  });

  it('rejects unparseable to with a 400', () => {
    expect(() => parseRange({ to: 'garbage' })).toThrowError('invalid time range');
  });

  it('rejects inverted ranges', () => {
    expect(() =>
      parseRange({ from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' }),
    ).toThrowError('invalid time range');
  });

  it('rejects empty ranges (from equal to to)', () => {
    expect(() =>
      parseRange({ from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }),
    ).toThrowError('invalid time range');
  });
});

describe('parseRange bounds', () => {
  it('rejects repeated parameters, timestamps outside 1970..9999 and ranges over the cap', () => {
    expect(() => parseRange({ from: ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'] })).toThrowError('invalid time range');
    expect(() => parseRange({ from: '1960-01-01T00:00:00Z', to: '1961-01-01T00:00:00Z' })).toThrowError('invalid time range');
    expect(() => parseRange({ from: '2026-01-01T00:00:00Z', to: '+012000-01-01T00:00:00Z' })).toThrowError('invalid time range');
    expect(() => parseRange({ from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })).toThrowError('invalid time range');
    expect(parseRange({ from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }).toMs).toBe(Date.parse('2026-01-01T00:00:00Z'));
  });
});

describe('parseIntParam', () => {
  const opts = { def: 25, min: 1, max: 50 };
  it('defaults when absent or empty and accepts integers in range', () => {
    expect(parseIntParam({}, 'limit', opts)).toBe(25);
    expect(parseIntParam({ limit: '' }, 'limit', opts)).toBe(25);
    expect(parseIntParam({ limit: '1' }, 'limit', opts)).toBe(1);
    expect(parseIntParam({ limit: '50' }, 'limit', opts)).toBe(50);
  });

  it('answers 400 for fractions, exponents, signs, out-of-range and repeated values', () => {
    for (const limit of ['2.5', '1e1', '-3', '+3', '0', '51', 'abc', ' 5', '0x10', '99999999999', ['5', '6']]) {
      let status = 0;
      try {
        parseIntParam({ limit }, 'limit', opts);
      } catch (err) {
        status = (err as { statusCode?: number }).statusCode ?? -1;
      }
      expect(status, String(limit)).toBe(400);
    }
  });
});
