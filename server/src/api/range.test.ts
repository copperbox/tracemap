import { describe, expect, it } from 'vitest';
import { parseRange, rangeMs } from './range.js';

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
