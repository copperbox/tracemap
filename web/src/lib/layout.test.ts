import { describe, expect, it } from 'vitest';
import { layoutGraph } from './layout';

describe('layoutGraph', () => {
  it('places leaf dependencies at the top (layer 0) and callers below', () => {
    // gw -> bff -> svc -> db
    const { pos } = layoutGraph({
      keys: ['gw', 'bff', 'svc', 'db'],
      deps: new Map([
        ['gw', ['bff']],
        ['bff', ['svc']],
        ['svc', ['db']],
      ]),
    });
    expect(pos.get('db')?.y).toBe(0);
    expect(pos.get('svc')?.y).toBeGreaterThan(pos.get('db')?.y as number);
    expect(pos.get('bff')?.y).toBeGreaterThan(pos.get('svc')?.y as number);
    expect(pos.get('gw')?.y).toBeGreaterThan(pos.get('bff')?.y as number);
  });

  it('keeps a minimum horizontal pitch within a layer', () => {
    const { pos } = layoutGraph({
      keys: ['a', 'b', 'x'],
      deps: new Map([
        ['a', ['x']],
        ['b', ['x']],
      ]),
    });
    const ax = pos.get('a')?.x as number;
    const bx = pos.get('b')?.x as number;
    expect(Math.abs(ax - bx)).toBeGreaterThanOrEqual(216);
  });

  it('survives dependency cycles without infinite recursion', () => {
    const { pos } = layoutGraph({
      keys: ['a', 'b', 'c'],
      deps: new Map([
        ['a', ['b']],
        ['b', ['c']],
        ['c', ['a']], // cycle
      ]),
    });
    expect(pos.size).toBe(3);
    const ys = ['a', 'b', 'c'].map((k) => pos.get(k)?.y);
    expect(new Set(ys).size).toBeGreaterThan(1); // still layered
  });

  it('ignores unknown and self dependencies', () => {
    const { pos, bbox } = layoutGraph({
      keys: ['a'],
      deps: new Map([['a', ['a', 'ghost']]]),
    });
    expect(pos.get('a')).toEqual({ x: 0, y: 0 });
    expect(bbox.x1).toBeGreaterThan(0);
  });

  it('handles empty input', () => {
    const { pos } = layoutGraph({ keys: [], deps: new Map() });
    expect(pos.size).toBe(0);
  });

  it('is deterministic regardless of dependency list ordering', () => {
    // The API may return edges in any row order; positions must not drift.
    const keys = ['gw', 'bff1', 'bff2', 'svc1', 'svc2', 'db1', 'db2'];
    const depsA = new Map([
      ['gw', ['bff1', 'bff2']],
      ['bff1', ['svc1', 'svc2']],
      ['bff2', ['svc2']],
      ['svc1', ['db1']],
      ['svc2', ['db1', 'db2']],
    ]);
    const depsB = new Map([
      ['svc2', ['db2', 'db1']],
      ['bff2', ['svc2']],
      ['gw', ['bff2', 'bff1']],
      ['svc1', ['db1']],
      ['bff1', ['svc2', 'svc1']],
    ]);
    const a = layoutGraph({ keys, deps: depsA });
    const b = layoutGraph({ keys, deps: depsB });
    for (const k of keys) {
      expect(b.pos.get(k)).toEqual(a.pos.get(k));
    }
  });
});
