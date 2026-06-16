import { describe, expect, it } from 'vitest';
import { CENTER_MIN_K, FIT_MAX_K, FIT_MIN_K, LABEL_MIN_K, centerTransform, fitZoom } from './camera';

// A 100x60 box centered at (150, 130).
const box = { x0: 100, y0: 100, x1: 200, y1: 160 };
const center = (k: number, opts = {}) => centerTransform(box, 1000, 800, k, opts);

describe('centerTransform', () => {
  it('places the box center at the canvas center', () => {
    const tf = center(CENTER_MIN_K);
    const cx = 150 * tf.k + tf.tx; // screen = world * k + t
    const cy = 130 * tf.k + tf.ty;
    expect(cx).toBeCloseTo(500); // viewW / 2
    expect(cy).toBeCloseTo(400); // viewH / 2
  });

  it('zooms in to minK when the current zoom is below it', () => {
    expect(center(0.2).k).toBeCloseTo(CENTER_MIN_K);
  });

  it('keeps the current zoom when already past minK (never zooms out)', () => {
    expect(center(1.5).k).toBeCloseTo(1.5);
  });

  it('clamps to maxK', () => {
    expect(center(9).k).toBeCloseTo(2.4);
  });

  it('reserves the drawer width so the center shifts left', () => {
    const plain = center(CENTER_MIN_K);
    const inset = center(CENTER_MIN_K, { rightInset: 352 });
    // box center now sits at (viewW - inset) / 2 on screen, i.e. further left.
    const sx = 150 * inset.k + inset.tx;
    expect(sx).toBeCloseTo((1000 - 352) / 2);
    expect(inset.tx).toBeLessThan(plain.tx);
  });

  it('respects a custom minK', () => {
    expect(center(0.2, { minK: 0.5 }).k).toBeCloseTo(0.5);
  });

  it('exposes a label threshold below the centering zoom', () => {
    expect(LABEL_MIN_K).toBeLessThan(CENTER_MIN_K);
  });
});

describe('fitZoom', () => {
  it('zooms in to fit a small box, capped at FIT_MAX_K', () => {
    expect(fitZoom({ x0: 0, y0: 0, x1: 50, y1: 50 }, 1000, 800)).toBeCloseTo(FIT_MAX_K);
  });

  it('shrinks to specks for a box far taller than the canvas', () => {
    // a tall narrow cone (like a full-height dependency tree) cannot be framed
    // legibly: the resulting zoom falls below the label threshold.
    const k = fitZoom({ x0: 0, y0: 0, x1: 200, y1: 8000 }, 1000, 800);
    expect(k).toBeLessThan(LABEL_MIN_K);
    expect(k).toBeGreaterThanOrEqual(FIT_MIN_K);
  });

  it('clamps to FIT_MIN_K for an enormous box', () => {
    expect(fitZoom({ x0: 0, y0: 0, x1: 1e6, y1: 1e6 }, 1000, 800)).toBeCloseTo(FIT_MIN_K);
  });

  it('is constrained by the tighter axis', () => {
    const wide = fitZoom({ x0: 0, y0: 0, x1: 4000, y1: 100 }, 1000, 800);
    // limited by width: (1000 - 120) / 4000 = 0.22
    expect(wide).toBeCloseTo(0.22);
  });
});
