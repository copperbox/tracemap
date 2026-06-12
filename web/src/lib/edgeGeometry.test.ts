import { describe, expect, it } from 'vitest';
import { computeEdgeGeometries, pickSides, type Rect } from './edgeGeometry';

const rect = (x: number, y: number, w = 100, h = 50): Rect => ({ x, y, w, h });

describe('pickSides', () => {
  it('uses bottom -> top when the dependent is below the dependency', () => {
    expect(pickSides(rect(0, 0), rect(0, 300))).toEqual({ exit: 'bottom', entry: 'top' });
  });

  it('uses top -> bottom when the dependent is above (backward edge)', () => {
    expect(pickSides(rect(0, 300), rect(0, 0))).toEqual({ exit: 'top', entry: 'bottom' });
  });

  it('uses right -> left for side-by-side nodes', () => {
    expect(pickSides(rect(0, 0), rect(400, 10))).toEqual({ exit: 'right', entry: 'left' });
  });

  it('uses left -> right when the dependent is to the left', () => {
    expect(pickSides(rect(400, 10), rect(0, 0))).toEqual({ exit: 'left', entry: 'right' });
  });

  it('biases toward vertical attachment on diagonals', () => {
    // dx 200, dy 150: |dy| >= |dx| * 0.55, so still vertical
    expect(pickSides(rect(0, 0), rect(200, 150))).toEqual({ exit: 'bottom', entry: 'top' });
  });
});

describe('computeEdgeGeometries', () => {
  // c and d stay within the vertical-attachment zone relative to b
  const rects: Record<string, Rect> = {
    a: rect(0, 0),
    b: rect(0, 300),
    c: rect(150, 0),
    d: rect(300, 0),
  };
  const rectOf = (k: string): Rect | undefined => rects[k];

  it('skips edges with a missing endpoint', () => {
    const out = computeEdgeGeometries([{ key: 'x', fromKey: 'a', toKey: 'missing' }], rectOf);
    expect(out.size).toBe(0);
  });

  it('starts the path at the dependency and ends at the dependent', () => {
    const out = computeEdgeGeometries([{ key: 'e', fromKey: 'a', toKey: 'b' }], rectOf);
    const g = out.get('e');
    expect(g).toBeDefined();
    // exits a's bottom (y=50), enters b's top (y=300)
    expect(g?.d).toMatch(/^M 50 50 C /);
    expect(g?.d).toMatch(/ 50 300$/);
  });

  it('points the arrowhead into the dependent for backward (upward) edges', () => {
    const out = computeEdgeGeometries([{ key: 'e', fromKey: 'b', toKey: 'a' }], rectOf);
    const g = out.get('e');
    // enters a's bottom edge: tip at y=50, base 8px below (outside the node)
    const pts = (g?.arrow ?? '').split(' ').map((p) => p.split(',').map(Number));
    expect(pts[0][1]).toBe(50);
    expect(pts[1][1]).toBe(58);
    expect(pts[2][1]).toBe(58);
  });

  it('spreads anchors that share a node side instead of stacking them', () => {
    const out = computeEdgeGeometries(
      [
        { key: 'e1', fromKey: 'a', toKey: 'b' },
        { key: 'e2', fromKey: 'c', toKey: 'b' },
        { key: 'e3', fromKey: 'd', toKey: 'b' },
      ],
      rectOf,
    );
    const entryX = (key: string): number => {
      const m = (out.get(key)?.d ?? '').match(/ (\S+) (\S+)$/) as RegExpMatchArray;
      return Number(m[1]);
    };
    const xs = [entryX('e1'), entryX('e2'), entryX('e3')];
    expect(new Set(xs).size).toBe(3);
    // ordered by where the far endpoint sits: a (x=0), c (x=150), d (x=300)
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    // all within b's top edge
    for (const x of xs) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(100);
    }
  });

  it('places the label point on the curve between the two nodes', () => {
    const out = computeEdgeGeometries([{ key: 'e', fromKey: 'a', toKey: 'b' }], rectOf);
    const mid = out.get('e')?.mid;
    expect(mid?.x).toBe(50);
    expect(mid?.y).toBeGreaterThan(50);
    expect(mid?.y).toBeLessThan(300);
  });

  it('is deterministic regardless of input order', () => {
    const edges = [
      { key: 'e1', fromKey: 'a', toKey: 'b' },
      { key: 'e2', fromKey: 'c', toKey: 'b' },
    ];
    const fwd = computeEdgeGeometries(edges, rectOf);
    const rev = computeEdgeGeometries([...edges].reverse(), rectOf);
    expect(fwd.get('e1')).toEqual(rev.get('e1'));
    expect(fwd.get('e2')).toEqual(rev.get('e2'));
  });
});
