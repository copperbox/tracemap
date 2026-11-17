import { describe, expect, it } from 'vitest';
import { FADE_END, FADE_FLOOR, FADE_START, edgeStroke, healthyEdgeFade } from './edgeDensity';

const view = (status: string, over: Partial<{ dim: boolean; isSel: boolean; isHov: boolean }> = {}) => ({
  op: 0.5,
  arrowOp: 0.6,
  dim: false,
  isSel: false,
  isHov: false,
  e: { status },
  ...over,
});

describe('healthyEdgeFade', () => {
  it('leaves the 40-service demo (63 edges) at full strength', () => {
    expect(healthyEdgeFade(63)).toBe(1);
  });
  it('fades a few hundred edges, as seen at card zoom on a large fleet', () => {
    expect(healthyEdgeFade(300)).toBeLessThan(0.7);
  });
  it('leaves small maps alone and bottoms out on dense ones', () => {
    expect(healthyEdgeFade(0)).toBe(1);
    expect(healthyEdgeFade(FADE_START)).toBe(1);
    expect(healthyEdgeFade(FADE_END)).toBe(FADE_FLOOR);
    expect(healthyEdgeFade(10_000)).toBe(FADE_FLOOR);
  });
  it('falls monotonically in between', () => {
    const a = healthyEdgeFade(500);
    const b = healthyEdgeFade(2000);
    expect(a).toBeLessThan(1);
    expect(b).toBeLessThan(a);
    expect(b).toBeGreaterThan(FADE_FLOOR);
  });
});

describe('edgeStroke', () => {
  it('draws everything as built at fade 1', () => {
    expect(edgeStroke(view('ok'), 1)).toEqual({ op: 0.5, arrowOp: 0.6, minPx: 0.6, maxPx: null });
    expect(edgeStroke(view('crit'), 1)).toEqual({ op: 0.5, arrowOp: 0.6, minPx: 0.6, maxPx: null });
  });
  it('fades healthy edges and strengthens unhealthy ones', () => {
    expect(edgeStroke(view('ok'), 0.1).op).toBeCloseTo(0.05);
    expect(edgeStroke(view('ok'), 0.1).maxPx).toBe(1);
    const bad = edgeStroke(view('warn'), 0.1);
    expect(bad.op).toBeCloseTo(0.95);
    expect(bad.minPx).toBeGreaterThan(1.1);
  });
  it('never fades the selected or hovered edge, nor lifts a dimmed one', () => {
    expect(edgeStroke(view('ok', { isSel: true }), 0.1).op).toBe(0.5);
    expect(edgeStroke(view('ok', { isHov: true }), 0.1).op).toBe(0.5);
    expect(edgeStroke(view('crit', { dim: true }), 0.1).op).toBe(0.5);
  });
  it('keeps edges on the focus tree at full strength', () => {
    expect(edgeStroke({ ...view('ok'), focused: true }, 0.1)).toEqual({ op: 0.5, arrowOp: 0.6, minPx: 0.6, maxPx: null });
  });
});
