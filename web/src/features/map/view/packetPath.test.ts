import { describe, expect, it } from 'vitest';
import type { CubicCurve } from '../../../lib/edgeGeometry';
import { buildArcLut, cubicAt, pointAtFraction } from './packetPath';

// a straight diagonal expressed as a cubic, so arc length == chord length and
// fractions map to exact coordinates we can assert against
// control points at exact thirds -> uniform parametrization, so t and arc
// fraction coincide and we can assert exact coordinates
const line: CubicCurve = {
  a: { x: 0, y: 0 },
  c1: { x: 100 / 3, y: 100 / 3 },
  c2: { x: 200 / 3, y: 200 / 3 },
  b: { x: 100, y: 100 },
};

describe('cubicAt', () => {
  it('returns the endpoints at t=0 and t=1', () => {
    expect(cubicAt(line, 0)).toEqual({ x: 0, y: 0 });
    expect(cubicAt(line, 1)).toEqual({ x: 100, y: 100 });
  });

  it('hits the midpoint of a symmetric straight cubic at t=0.5', () => {
    const m = cubicAt(line, 0.5);
    expect(m.x).toBeCloseTo(50);
    expect(m.y).toBeCloseTo(50);
  });
});

describe('buildArcLut', () => {
  it('measures the length of a straight cubic as its chord length', () => {
    const lut = buildArcLut(line);
    expect(lut.length).toBeCloseTo(Math.hypot(100, 100), 1);
  });

  it('produces samples + 1 points with monotonic cumulative length', () => {
    const lut = buildArcLut(line, 10);
    expect(lut.pts).toHaveLength(11);
    expect(lut.cum[0]).toBe(0);
    for (let i = 1; i < lut.cum.length; i++) {
      expect(lut.cum[i]).toBeGreaterThanOrEqual(lut.cum[i - 1]);
    }
  });
});

describe('pointAtFraction', () => {
  it('walks the line by arc length, so 0/0.5/1 hit start/middle/end', () => {
    const lut = buildArcLut(line);
    expect(pointAtFraction(lut, 0)).toEqual({ x: 0, y: 0 });
    const mid = pointAtFraction(lut, 0.5);
    expect(mid.x).toBeCloseTo(50, 1);
    expect(mid.y).toBeCloseTo(50, 1);
    const end = pointAtFraction(lut, 1);
    expect(end.x).toBeCloseTo(100, 1);
    expect(end.y).toBeCloseTo(100, 1);
  });

  it('clamps fractions outside [0, 1]', () => {
    const lut = buildArcLut(line);
    expect(pointAtFraction(lut, -1)).toEqual({ x: 0, y: 0 });
    expect(pointAtFraction(lut, 2).x).toBeCloseTo(100, 1);
  });

  it('handles a zero-length (degenerate) curve without dividing by zero', () => {
    const dot: CubicCurve = {
      a: { x: 5, y: 5 },
      c1: { x: 5, y: 5 },
      c2: { x: 5, y: 5 },
      b: { x: 5, y: 5 },
    };
    const lut = buildArcLut(dot);
    expect(pointAtFraction(lut, 0.7)).toEqual({ x: 5, y: 5 });
  });
});
