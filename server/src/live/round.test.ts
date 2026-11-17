import { describe, expect, it } from 'vitest';
import { roundMetrics, sig4, sig4OrNull } from './round.js';

describe('sig4', () => {
  it('rounds to 4 significant digits and prints short', () => {
    expect(sig4(12.345678)).toBe(12.35);
    expect(sig4(0.000123456)).toBe(0.0001235);
    expect(sig4(123_456.7)).toBe(123_500);
    expect(sig4(99.99999)).toBe(100);
    expect(sig4(-3.14159)).toBe(-3.142);
    expect(sig4(1234)).toBe(1234);
    expect(sig4(1e-30 * 1.23456)).toBe(1.235e-30);
    expect(sig4(1.23456e30)).toBe(1.235e30);
    expect(String(sig4(0.1 + 0.2))).toBe('0.3');
  });

  it('stays within half a unit of the 4th digit and never prints more than 4 digits', () => {
    for (let i = 0; i < 20_000; i++) {
      const v = Math.exp((Math.random() - 0.5) * 50) * (Math.random() < 0.1 ? -1 : 1);
      const got = sig4(v);
      expect(Math.abs(got - v)).toBeLessThanOrEqual(Math.abs(v) * 5e-4);
      const digits = String(Math.abs(got)).replace(/e.*$/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
      expect(digits.length).toBeLessThanOrEqual(4);
    }
  });

  it('passes 0, non-finite values and null through', () => {
    expect(sig4(0)).toBe(0);
    expect(Number.isNaN(sig4(NaN))).toBe(true);
    expect(sig4(Infinity)).toBe(Infinity);
    expect(sig4OrNull(null)).toBeNull();
    expect(sig4OrNull(2.71828)).toBe(2.718);
  });

  it('rounds the five live numbers and leaves the rest', () => {
    const m = { rps: 12.3456789, p50: null, p95: 40.123456, p99: 120.987654, errPct: 0.80004, stale: false, status: 'ok' as const };
    expect(roundMetrics(m)).toEqual({ rps: 12.35, p50: null, p95: 40.12, p99: 121, errPct: 0.8, stale: false, status: 'ok' });
  });
});
