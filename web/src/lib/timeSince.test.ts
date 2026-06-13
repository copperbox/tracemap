import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeSince } from './timeSince';

describe('timeSince', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns today for very recent timestamps', () => {
    expect(timeSince('2026-06-12T11:50:00Z')).toBe('today');
  });

  it('clamps future timestamps to today', () => {
    expect(timeSince('2026-06-13T12:00:00Z')).toBe('today');
  });

  it('formats whole hours', () => {
    expect(timeSince('2026-06-12T07:00:00Z')).toBe('5h ago');
  });

  it('rounds 30 minutes up to 1h', () => {
    expect(timeSince('2026-06-12T11:30:00Z')).toBe('1h ago');
  });

  it('uses the singular form at exactly one day', () => {
    expect(timeSince('2026-06-11T12:00:00Z')).toBe('1 day ago');
  });

  it('rounds half a day or more up to 1 day', () => {
    expect(timeSince('2026-06-11T23:00:00Z')).toBe('1 day ago');
  });

  it('uses the plural form for multiple days', () => {
    expect(timeSince('2026-06-09T12:00:00Z')).toBe('3 days ago');
  });
});
