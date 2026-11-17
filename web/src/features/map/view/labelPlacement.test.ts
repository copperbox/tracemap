import { describe, expect, it } from 'vitest';
import { bezierAt, labelBoxWidth, placeEdgeLabels, type LabelRequest } from './labelPlacement';

// A straight edge from (0,0) to (1000,0) as a cubic.
const line = { a: { x: 0, y: 0 }, c1: { x: 333, y: 0 }, c2: { x: 667, y: 0 }, b: { x: 1000, y: 0 } };
const req = (key: string, over: Partial<LabelRequest> = {}): LabelRequest => ({
  key,
  curve: line,
  w: 60,
  h: 19,
  force: false,
  ...over,
});

describe('bezierAt', () => {
  it('walks the curve from end to end', () => {
    expect(bezierAt(line, 0)).toEqual({ x: 0, y: 0 });
    expect(bezierAt(line, 1)).toEqual({ x: 1000, y: 0 });
    expect(bezierAt(line, 0.5).x).toBeCloseTo(500, 0);
  });
});

describe('placeEdgeLabels', () => {
  it('uses the midpoint when it is free', () => {
    const spots = placeEdgeLabels([req('e')], []);
    expect(spots.get('e')?.x).toBeCloseTo(500, 0);
  });

  it('moves off a card covering the midpoint', () => {
    const card = { x0: 400, y0: -40, x1: 600, y1: 40 };
    const p = placeEdgeLabels([req('e')], [card]).get('e');
    expect(p).toBeDefined();
    const box = { x0: p!.x - 30, x1: p!.x + 30 };
    expect(box.x1 <= card.x0 || box.x0 >= card.x1).toBe(true);
  });

  it('hides a label with no free spot', () => {
    const wall = { x0: -100, y0: -100, x1: 1100, y1: 100 };
    expect(placeEdgeLabels([req('e')], [wall]).has('e')).toBe(false);
  });

  it('still shows a selected or hovered label with no free spot', () => {
    const wall = { x0: -100, y0: -100, x1: 1100, y1: 100 };
    expect(placeEdgeLabels([req('e', { force: true })], [wall]).has('e')).toBe(true);
  });

  it('keeps labels on the same edge path apart, the forced one first', () => {
    const spots = placeEdgeLabels([req('a'), req('b', { force: true })], []);
    expect(spots.get('b')?.x).toBeCloseTo(500, 0);
    const a = spots.get('a')!;
    expect(Math.abs(a.x - 500)).toBeGreaterThanOrEqual(60);
  });
});

describe('labelBoxWidth', () => {
  it('grows with the text', () => {
    expect(labelBoxWidth('1.0s')).toBeLessThan(labelBoxWidth('12/s · 1.0s · 0.10%'));
  });
});
