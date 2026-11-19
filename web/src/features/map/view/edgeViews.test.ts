import { describe, expect, it } from 'vitest';
import type { EdgeGeometry } from '../../../lib/edgeGeometry';
import type { GraphEdge } from '../../../lib/grouping';
import { buildEdgeViews } from './edgeViews';

const edge = (over: Partial<GraphEdge> = {}): GraphEdge => ({
  key: 'a=>b',
  sourceKey: 'a',
  targetKey: 'b',
  status: 'ok',
  rps: 10,
  p95: 50,
  errPct: 0.1,
  stale: false,
  confidence: 99,
  samples: 100,
  underlying: [],
  ...over,
});

const geom: EdgeGeometry = {
  curve: { a: { x: 0, y: 0 }, c1: { x: 3, y: 3 }, c2: { x: 7, y: 7 }, b: { x: 10, y: 10 } },
  arrowPts: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 2 },
  ],
  mid: { x: 5, y: 5 },
};
const geoms = new Map([['a=>b', geom]]);

const base = {
  dimmed: () => false,
  selEdgeKey: null,
  fadeInOf: () => 1,
};

describe('buildEdgeViews', () => {
  it('skips edges without geometry', () => {
    expect(buildEdgeViews([edge({ key: 'x=>y' })], geoms, base)).toEqual([]);
  });

  it('carries the geometry through', () => {
    const [v] = buildEdgeViews([edge()], geoms, base);
    expect(v.curve).toBe(geom.curve);
    expect(v.arrowPts).toBe(geom.arrowPts);
    expect(v.mid).toEqual(geom.mid);
  });

  it('renders a healthy idle edge green with quiet flow', () => {
    const [v] = buildEdgeViews([edge({ rps: 0 })], geoms, base);
    expect(v.stroke).toBe('var(--accent)');
    expect(v.w).toBe(1.2);
    expect(v.op).toBeCloseTo(0.5);
    expect(v.flowOp).toBe(0);
  });

  it('silences the flow on stale edges even with traffic', () => {
    const [v] = buildEdgeViews([edge({ rps: 50, stale: true })], geoms, base);
    expect(v.flowOp).toBe(0);
  });

  it('animates the flow on live edges', () => {
    const [v] = buildEdgeViews([edge({ rps: 50 })], geoms, base);
    expect(v.flowOp).toBeCloseTo(0.7);
    expect(v.flowStroke).toBe('var(--accent)');
  });

  it('uses status colors for degraded and critical edges', () => {
    const [warn] = buildEdgeViews([edge({ status: 'warn' })], geoms, base);
    expect(warn.stroke).toBe('var(--warn)');
    expect(warn.flowStroke).toBe('var(--warn)');
    expect(warn.op).toBeCloseTo(0.75);
    expect(warn.flowOp).toBeCloseTo(0.95);
    expect(warn.arrowFill).toBe('var(--warn)');

    const [crit] = buildEdgeViews([edge({ status: 'crit' })], geoms, base);
    expect(crit.stroke).toBe('var(--crit)');
    expect(crit.arrowOp).toBeCloseTo(0.9);
  });

  it('highlights the selected edge', () => {
    const [v] = buildEdgeViews([edge()], geoms, { ...base, selEdgeKey: 'a=>b' });
    expect(v.isSel).toBe(true);
    expect(v.stroke).toBe('var(--accent)');
    expect(v.w).toBe(2);
    expect(v.op).toBeCloseTo(0.95);
    expect(v.arrowFill).toBe('var(--accent)');
  });

  it('keeps the status color when a degraded edge is selected', () => {
    const [sel] = buildEdgeViews([edge({ status: 'warn' })], geoms, { ...base, selEdgeKey: 'a=>b' });
    expect(sel.stroke).toBe('var(--warn)');
    expect(sel.arrowFill).toBe('var(--warn)');
  });

  it('glows the selected edge in its status color, and not otherwise', () => {
    const [plain] = buildEdgeViews([edge()], geoms, base);
    expect(plain.glow).toBeNull();

    const [okSel] = buildEdgeViews([edge()], geoms, { ...base, selEdgeKey: 'a=>b' });
    expect(okSel.glow).toBe('var(--accent)');

    const [critSel] = buildEdgeViews([edge({ status: 'crit' })], geoms, { ...base, selEdgeKey: 'a=>b' });
    expect(critSel.glow).toBe('var(--crit)');
  });

  it('does not glow a dimmed selected edge', () => {
    const [v] = buildEdgeViews([edge()], geoms, { ...base, selEdgeKey: 'a=>b', dimmed: () => true });
    expect(v.glow).toBeNull();
  });

  it('dims an off-tree edge even when both endpoints are lit', () => {
    // focus active, both endpoints undimmed, but this edge is not on the focus
    // tree -> it is a cross-link and must dim.
    const [v] = buildEdgeViews([edge()], geoms, { ...base, focusEdges: new Set(['other=>edge']) });
    expect(v.dim).toBe(true);
    expect(v.op).toBeCloseTo(0.04);
  });

  it('keeps an on-tree edge lit when it is in the focus set', () => {
    const [v] = buildEdgeViews([edge()], geoms, { ...base, focusEdges: new Set(['a=>b']) });
    expect(v.dim).toBe(false);
  });

  it('fades dimmed edges almost out and kills their flow', () => {
    const [v] = buildEdgeViews([edge({ rps: 50 })], geoms, { ...base, dimmed: (k) => k === 'a' });
    expect(v.dim).toBe(true);
    expect(v.op).toBeCloseTo(0.04);
    expect(v.arrowOp).toBeCloseTo(0.04);
    expect(v.flowOp).toBe(0);
  });

  it('multiplies all opacities by the transition fade-in', () => {
    const [v] = buildEdgeViews([edge({ rps: 50 })], geoms, { ...base, fadeInOf: () => 0.5 });
    expect(v.op).toBeCloseTo(0.5 * 0.5);
    expect(v.arrowOp).toBeCloseTo(0.6 * 0.5);
    expect(v.flowOp).toBeCloseTo(0.7 * 0.5);
  });

  describe('reuse of the previous result', () => {
    const three = [edge({ key: 'a=>b' }), edge({ key: 'b=>c', sourceKey: 'b', targetKey: 'c' }), edge({ key: 'c=>d', sourceKey: 'c', targetKey: 'd' })];
    const g3 = new Map(three.map((e) => [e.key, { ...geom, curve: { ...geom.curve } }]));

    it('returns the same view objects when nothing changed', () => {
      const first = buildEdgeViews(three, g3, base);
      const again = buildEdgeViews(three, g3, base, first);
      expect(again).toHaveLength(3);
      again.forEach((v, i) => expect(v).toBe(first[i]));
    });

    it('rebuilds only the views a selection touches', () => {
      const first = buildEdgeViews(three, g3, base);
      const sel = buildEdgeViews(three, g3, { ...base, selEdgeKey: 'b=>c' }, first);
      expect(sel[0]).toBe(first[0]);
      expect(sel[1]).not.toBe(first[1]);
      expect(sel[1].isSel).toBe(true);
      expect(sel[2]).toBe(first[2]);
    });

    it('rebuilds a view whose edge object or geometry was replaced', () => {
      const first = buildEdgeViews(three, g3, base);
      const fresh = [three[0], { ...three[1], rps: 99 }, three[2]];
      const afterMetrics = buildEdgeViews(fresh, g3, base, first);
      expect(afterMetrics[0]).toBe(first[0]);
      expect(afterMetrics[1]).not.toBe(first[1]);
      expect(afterMetrics[1].e.rps).toBe(99);

      const moved = new Map(g3);
      moved.set('c=>d', { ...geom, curve: { ...geom.curve } });
      const afterMove = buildEdgeViews(three, moved, base, first);
      expect(afterMove[1]).toBe(first[1]);
      expect(afterMove[2]).not.toBe(first[2]);
    });

    it('stays aligned when an edge without geometry is skipped', () => {
      const partial = new Map(g3);
      partial.delete('a=>b');
      const first = buildEdgeViews(three, partial, base);
      expect(first.map((v) => v.e.key)).toEqual(['b=>c', 'c=>d']);
      const again = buildEdgeViews(three, partial, base, first);
      again.forEach((v, i) => expect(v).toBe(first[i]));
    });
  });
});
