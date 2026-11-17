import { describe, expect, it } from 'vitest';
import { gridColumns, keyStep, revealScrollTop, windowRange } from './windowing';

const base = { scrollTop: 0, viewportHeight: 500, listTop: 100, rowHeight: 50, rowCount: 5000, overscan: 2 };

describe('windowRange', () => {
  it('mounts the rows in view plus overscan at the top of the list', () => {
    // List starts 100px down: rows 0-7 are visible (400px of list in view).
    expect(windowRange(base)).toEqual({ start: 0, end: 10, offset: 0, totalHeight: 250_000 });
  });

  it('follows the scroll position', () => {
    const r = windowRange({ ...base, scrollTop: 10_100 });
    // List-relative top is 10,000px = row 200; bottom 10,500 = row 210.
    expect(r).toEqual({ start: 198, end: 212, offset: 9900, totalHeight: 250_000 });
  });

  it('clamps at the end of the list', () => {
    const r = windowRange({ ...base, scrollTop: 249_700 + 100 });
    expect(r.end).toBe(5000);
    expect(r.start).toBe(4992);
  });

  it('mounts nothing when the list is scrolled far out of view or empty', () => {
    expect(windowRange({ ...base, rowCount: 0 })).toEqual({ start: 0, end: 0, offset: 0, totalHeight: 0 });
    const below = windowRange({ ...base, rowCount: 3, scrollTop: 10_000 });
    expect(below.end - below.start).toBe(0);
  });

  it('handles a fractional scroll that straddles rows', () => {
    const r = windowRange({ ...base, overscan: 0, listTop: 0, scrollTop: 25, viewportHeight: 100 });
    expect([r.start, r.end]).toEqual([0, 3]);
  });
});

describe('gridColumns', () => {
  it('matches auto-fill minmax column counts', () => {
    expect(gridColumns(1116, 230, 14)).toBe(4); // (1116+14)/244 = 4.6
    expect(gridColumns(230, 230, 14)).toBe(1);
    expect(gridColumns(100, 230, 14)).toBe(1);
    expect(gridColumns(0, 230, 14)).toBe(1);
    expect(gridColumns(474, 230, 14)).toBe(2);
  });
});

describe('revealScrollTop', () => {
  const w = { scrollTop: 1000, viewportHeight: 500, listTop: 100, rowHeight: 50 };
  it('returns null for a row already in view', () => {
    expect(revealScrollTop(20, w)).toBeNull(); // 1100-1150
  });
  it('scrolls up or down just enough', () => {
    expect(revealScrollTop(10, w)).toBe(600); // row top 600
    expect(revealScrollTop(30, w)).toBe(1650 - 500); // row bottom 1650
  });
  it('accounts for a sticky header', () => {
    expect(revealScrollTop(18, w, 60)).toBe(1000 - 60); // row 18 top 1000 sits under the header
  });
});

describe('keyStep', () => {
  it('moves by row and column, clamped', () => {
    expect(keyStep('ArrowDown', 0, 10)).toBe(1);
    expect(keyStep('ArrowUp', 0, 10)).toBe(0);
    expect(keyStep('ArrowDown', 1, 10, 4)).toBe(5);
    expect(keyStep('ArrowRight', 9, 10, 4)).toBe(9);
    expect(keyStep('ArrowRight', 3, 10, 1)).toBeNull();
    expect(keyStep('End', 3, 10)).toBe(9);
    expect(keyStep('Home', 3, 10)).toBe(0);
    expect(keyStep('PageDown', 3, 100, 1, 10)).toBe(13);
    expect(keyStep('Enter', 3, 10)).toBeNull();
    expect(keyStep('ArrowDown', 0, 0)).toBeNull();
  });
});
