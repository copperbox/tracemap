import { describe, expect, it } from 'vitest';
import { fmtErr, fmtMs, fmtRps, fmtCount } from './format';
import { QUICK_RANGES, isLiveRange, rangeLabel, resolveRange } from './timerange';

describe('formatters', () => {
  it('fmtRps', () => {
    expect(fmtRps(950)).toBe('950');
    expect(fmtRps(1850)).toBe('1.9k');
    expect(fmtRps(null)).toBe('--');
  });

  it('fmtMs', () => {
    expect(fmtMs(3.21)).toBe('3.2ms');
    expect(fmtMs(245)).toBe('245ms');
    expect(fmtMs(1280)).toBe('1.28s');
    expect(fmtMs(null)).toBe('--');
  });

  it('fmtErr', () => {
    expect(fmtErr(0.123)).toBe('0.12%');
    expect(fmtErr(4.2)).toBe('4.2%');
  });

  it('fmtCount', () => {
    expect(fmtCount(1_500_000)).toBe('1.5M');
    expect(fmtCount(42_000)).toBe('42k');
    expect(fmtCount(12)).toBe('12');
  });
});

describe('time ranges', () => {
  it('quick ranges resolve relative to now', () => {
    const now = Date.parse('2026-06-11T12:00:00Z');
    const r = QUICK_RANGES.find((q) => q.label === 'Last 3 hours');
    const { from, to } = resolveRange({ kind: 'quick', label: r!.label, ms: r!.ms }, now);
    expect(to.getTime()).toBe(now);
    expect(from.getTime()).toBe(now - 3 * 3600_000);
  });

  it('absolute ranges resolve exactly and are not live', () => {
    const range = { kind: 'absolute' as const, from: 1000, to: 2000 };
    const { from, to } = resolveRange(range);
    expect(from.getTime()).toBe(1000);
    expect(to.getTime()).toBe(2000);
    expect(isLiveRange(range)).toBe(false);
    expect(isLiveRange({ kind: 'quick', label: 'x', ms: 1 })).toBe(true);
  });

  it('labels both kinds', () => {
    expect(rangeLabel({ kind: 'quick', label: 'Last 24 hours', ms: 1 })).toBe('Last 24 hours');
    expect(rangeLabel({ kind: 'absolute', from: Date.parse('2026-06-10T09:30:00'), to: Date.parse('2026-06-11T10:00:00') })).toContain('2026-06-10 09:30');
  });
});
