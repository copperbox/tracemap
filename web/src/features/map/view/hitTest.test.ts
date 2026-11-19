import { describe, expect, it } from 'vitest';
import type { CubicCurve } from '../../../lib/edgeGeometry';
import { curveBox, distSqToSegment, distToCurve, flattenCubic, hitEdge, hitRect } from './hitTest';

const line = (x0: number, y0: number, x1: number, y1: number): CubicCurve => ({
  a: { x: x0, y: y0 },
  c1: { x: x0 + (x1 - x0) / 3, y: y0 + (y1 - y0) / 3 },
  c2: { x: x0 + (2 * (x1 - x0)) / 3, y: y0 + (2 * (y1 - y0)) / 3 },
  b: { x: x1, y: y1 },
});

describe('hitRect', () => {
  const items = [
    { key: 'a', rect: { x0: 0, y0: 0, x1: 100, y1: 50 } },
    { key: 'b', rect: { x0: 80, y0: 0, x1: 180, y1: 50 } },
  ];

  it('finds the rect under the point', () => {
    expect(hitRect(items, 10, 10)).toBe('a');
    expect(hitRect(items, 150, 10)).toBe('b');
  });

  it('prefers the later (topmost) rect where they overlap', () => {
    expect(hitRect(items, 90, 10)).toBe('b');
  });

  it('misses outside every rect unless padded', () => {
    expect(hitRect(items, 50, 55)).toBeNull();
    expect(hitRect(items, 50, 55, 6)).toBe('a');
  });
});

describe('distSqToSegment', () => {
  it('measures to the nearest point on the segment', () => {
    expect(distSqToSegment(5, 3, 0, 0, 10, 0)).toBe(9);
  });

  it('measures to an endpoint past the segment end', () => {
    expect(distSqToSegment(13, 4, 0, 0, 10, 0)).toBe(25);
  });

  it('handles a zero-length segment', () => {
    expect(distSqToSegment(3, 4, 0, 0, 0, 0)).toBe(25);
  });
});

describe('curves', () => {
  it('flattens to samples + 1 points from end to end', () => {
    const pts = flattenCubic(line(0, 0, 120, 0), 12);
    expect(pts).toHaveLength(13);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[12].x).toBeCloseTo(120);
  });

  it('boxes the control points', () => {
    expect(curveBox(line(10, 50, 110, 0))).toEqual({ x0: 10, y0: 0, x1: 110, y1: 50 });
  });

  it('measures distance to a straight curve', () => {
    expect(distToCurve(line(0, 0, 100, 0), 50, 7)).toBeCloseTo(7);
  });
});

describe('hitEdge', () => {
  const edges = [
    { key: 'h', curve: line(0, 0, 200, 0) },
    { key: 'v', curve: line(100, -100, 100, 100) },
  ];

  it('picks the edge within tolerance', () => {
    expect(hitEdge(edges, 30, 4, 6)).toBe('h');
    expect(hitEdge(edges, 104, 60, 6)).toBe('v');
  });

  it('picks the nearer edge where two are in range', () => {
    expect(hitEdge(edges, 103, 1, 6)).toBe('h');
    expect(hitEdge(edges, 101, 4, 6)).toBe('v');
  });

  it('misses when nothing is within tolerance', () => {
    expect(hitEdge(edges, 30, 20, 6)).toBeNull();
  });
});
