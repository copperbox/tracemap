import { describe, expect, it } from 'vitest';
import type { Transform } from './usePanZoom';
import { containsRect, needsRecull, rectsOverlap, shouldMount, visibleWorldRect, type WorldRect } from './viewport';

const tf = (over: Partial<Transform> = {}): Transform => ({ tx: 0, ty: 0, k: 1, ...over });

describe('visibleWorldRect', () => {
  it('maps the screen viewport to world coords (identity transform)', () => {
    // Field-wise (not toEqual) because -margin/k yields a signed -0 that
    // Object.is treats as != 0; the value is mathematically zero.
    const r = visibleWorldRect(tf(), 800, 600, 0);
    expect(r.x0).toBeCloseTo(0);
    expect(r.y0).toBeCloseTo(0);
    expect(r.x1).toBeCloseTo(800);
    expect(r.y1).toBeCloseTo(600);
  });

  it('grows the rect by the margin on every side', () => {
    expect(visibleWorldRect(tf(), 800, 600, 100)).toEqual({ x0: -100, y0: -100, x1: 900, y1: 700 });
  });

  it('shrinks the world span as zoom increases (fewer world units visible)', () => {
    // At k=2 a 800px-wide viewport only spans 400 world units.
    const r = visibleWorldRect(tf({ k: 2 }), 800, 600, 0);
    expect(r.x0).toBeCloseTo(0);
    expect(r.y0).toBeCloseTo(0);
    expect(r.x1).toBeCloseTo(400);
    expect(r.y1).toBeCloseTo(300);
  });

  it('accounts for pan translation', () => {
    // Panning the world right by 200px (tx=200) reveals world to the left of 0.
    const r = visibleWorldRect(tf({ tx: 200, ty: 100 }), 800, 600, 0);
    expect(r).toEqual({ x0: -200, y0: -100, x1: 600, y1: 500 });
  });

  it('treats a zero zoom as 1 to avoid dividing by zero', () => {
    const r = visibleWorldRect(tf({ k: 0 }), 800, 600, 0);
    expect(Number.isFinite(r.x1)).toBe(true);
  });
});

describe('rectsOverlap', () => {
  const view: WorldRect = { x0: 0, y0: 0, x1: 100, y1: 100 };

  it('detects an overlapping rect', () => {
    expect(rectsOverlap(view, { x0: 50, y0: 50, x1: 150, y1: 150 })).toBe(true);
  });

  it('detects a fully contained rect', () => {
    expect(rectsOverlap(view, { x0: 10, y0: 10, x1: 20, y1: 20 })).toBe(true);
  });

  it('counts shared edges as overlap', () => {
    expect(rectsOverlap(view, { x0: 100, y0: 0, x1: 200, y1: 100 })).toBe(true);
  });

  it('rejects a rect off to the right', () => {
    expect(rectsOverlap(view, { x0: 101, y0: 0, x1: 200, y1: 100 })).toBe(false);
  });

  it('rejects a rect off above', () => {
    expect(rectsOverlap(view, { x0: 0, y0: -200, x1: 100, y1: -1 })).toBe(false);
  });
});

describe('needsRecull', () => {
  const win = { rect: { x0: 0, y0: 0, x1: 1000, y1: 800 }, k: 0.8 };

  it('rebuilds when nothing is mounted yet', () => {
    expect(needsRecull(null, { x0: 0, y0: 0, x1: 10, y1: 10 }, 1)).toBe(true);
  });

  it('keeps the window while the view stays inside it', () => {
    expect(needsRecull(win, { x0: 100, y0: 100, x1: 900, y1: 700 }, 0.8)).toBe(false);
  });

  it('rebuilds when the view leaves the window', () => {
    expect(needsRecull(win, { x0: 300, y0: 100, x1: 1100, y1: 700 }, 0.8)).toBe(true);
  });

  it('rebuilds when the zoom drifts too far', () => {
    expect(needsRecull(win, { x0: 300, y0: 300, x1: 400, y1: 400 }, 1.2)).toBe(true);
    expect(needsRecull(win, { x0: 300, y0: 300, x1: 400, y1: 400 }, 0.9)).toBe(false);
  });
});

describe('containsRect', () => {
  it('accepts a rect on the boundary and rejects one sticking out', () => {
    const outer: WorldRect = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(containsRect(outer, { x0: 0, y0: 0, x1: 10, y1: 10 })).toBe(true);
    expect(containsRect(outer, { x0: 0, y0: 0, x1: 11, y1: 10 })).toBe(false);
  });
});

describe('shouldMount', () => {
  const win: WorldRect = { x0: 0, y0: 0, x1: 100, y1: 100 };
  const far: WorldRect = { x0: 500, y0: 500, x1: 600, y1: 560 };
  it('culls a card outside the window', () => {
    expect(shouldMount(win, far, 'a', new Set())).toBe(false);
    expect(shouldMount(win, { x0: 50, y0: 50, x1: 150, y1: 110 }, 'a', new Set())).toBe(true);
  });
  it('keeps a selected, focused or dragged card mounted off-screen', () => {
    expect(shouldMount(win, far, 'a', new Set(['a']))).toBe(true);
    expect(shouldMount(win, far, 'b', new Set(['a']))).toBe(false);
  });
});
