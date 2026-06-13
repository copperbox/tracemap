import { describe, expect, it } from 'vitest';
import type { EdgeGeometry } from '../../../lib/edgeGeometry';
import { flowDuration } from '../../../lib/flow';
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

const geom: EdgeGeometry = { d: 'M0 0 L10 10', arrow: '0,0 1,1 2,2', mid: { x: 5, y: 5 } };
const geoms = new Map([['a=>b', geom]]);

const base = {
  dimmed: () => false,
  selEdgeKey: null,
  hoverEdge: null,
  fadeInOf: () => 1,
};

describe('buildEdgeViews', () => {
  it('skips edges without geometry', () => {
    expect(buildEdgeViews([edge({ key: 'x=>y' })], geoms, base)).toEqual([]);
  });

  it('carries the geometry and flow duration through', () => {
    const [v] = buildEdgeViews([edge()], geoms, base);
    expect(v.d).toBe(geom.d);
    expect(v.arrow).toBe(geom.arrow);
    expect(v.mid).toEqual(geom.mid);
    expect(v.dur).toBe(flowDuration(10));
  });

  it('renders a healthy idle edge with base stroke and quiet flow', () => {
    const [v] = buildEdgeViews([edge({ rps: 0 })], geoms, base);
    expect(v.stroke).toBe('var(--edge)');
    expect(v.w).toBe(1.1);
    expect(v.op).toBeCloseTo(0.4);
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

  it('highlights the hovered edge slightly less than selection', () => {
    const [v] = buildEdgeViews([edge()], geoms, { ...base, hoverEdge: 'a=>b' });
    expect(v.isHov).toBe(true);
    expect(v.w).toBe(1.8);
    expect(v.op).toBeCloseTo(0.85);
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
    expect(v.op).toBeCloseTo(0.4 * 0.5);
    expect(v.arrowOp).toBeCloseTo(0.55 * 0.5);
    expect(v.flowOp).toBeCloseTo(0.7 * 0.5);
  });
});
