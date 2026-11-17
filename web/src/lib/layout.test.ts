import { describe, expect, it } from 'vitest';
import { layoutGraph, NODE_H, NODE_W } from './layout';

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

  it('separates a mutually dependent pair into distinct layers', () => {
    const { pos } = layoutGraph({
      keys: ['a', 'b'],
      deps: new Map([
        ['a', ['b']],
        ['b', ['a']],
      ]),
    });
    expect(pos.get('a')?.y).not.toBe(pos.get('b')?.y);
  });

  it('keeps the dominant flow downward when one feedback edge closes a cycle', () => {
    // chain leaf <- s1 <- s2 <- gw, plus leaf depending back on gw
    const deps = new Map([
      ['s1', ['leaf']],
      ['s2', ['s1']],
      ['gw', ['s2']],
      ['leaf', ['gw']],
    ]);
    const { pos } = layoutGraph({ keys: ['gw', 'leaf', 's1', 's2'], deps });
    const y = (k: string): number => pos.get(k)?.y as number;
    let down = 0;
    let up = 0;
    for (const [k, ds] of deps) {
      for (const d of ds) {
        if (y(d) < y(k)) down++;
        else up++;
      }
    }
    expect(down).toBe(3);
    expect(up).toBe(1);
  });

  it('layers a dense cyclic graph with most edges pointing downward', () => {
    // shaped like the team-grouped map: a hub both feeds and consumes others
    const deps = new Map([
      ['hub', ['t1', 't2', 't3']],
      ['t1', ['hub', 'leaf']],
      ['t2', ['hub', 't1']],
      ['t3', ['t2']],
      ['leaf', []],
    ]);
    const keys = ['hub', 'leaf', 't1', 't2', 't3'];
    const { pos } = layoutGraph({ keys, deps });
    expect(pos.size).toBe(keys.length);
    const y = (k: string): number => pos.get(k)?.y as number;
    let down = 0;
    let total = 0;
    for (const [k, ds] of deps) {
      for (const d of ds) {
        total++;
        if (y(d) < y(k)) down++;
      }
    }
    expect(down / total).toBeGreaterThan(0.6);
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

  describe('wrapAspect', () => {
    // one wide layer: 200 independent leaves
    const keys = Array.from({ length: 200 }, (_, i) => `n${String(i).padStart(3, '0')}`);
    const deps = new Map<string, string[]>();

    it('leaves a layout that fits the minimum row width unwrapped', () => {
      const few = keys.slice(0, 10);
      const plain = layoutGraph({ keys: few, deps });
      const wrapped = layoutGraph({ keys: few, deps, wrapAspect: 1.6 });
      expect(wrapped.bbox).toEqual(plain.bbox);
    });

    it('packs a wide layer into rows close to the target aspect', () => {
      const { bbox } = layoutGraph({ keys, deps, wrapAspect: 1.6 });
      const aspect = (bbox.x1 - bbox.x0) / (bbox.y1 - bbox.y0);
      expect(aspect).toBeGreaterThan(1.2);
      expect(aspect).toBeLessThan(2.4);
    });

    it('never overlaps two nodes', () => {
      const { pos } = layoutGraph({ keys, deps, wrapAspect: 1.6 });
      const all = [...pos.values()];
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i];
          const b = all[j];
          const overlap = a.x < b.x + NODE_W && b.x < a.x + NODE_W && a.y < b.y + NODE_H && b.y < a.y + NODE_H;
          expect(overlap).toBe(false);
        }
      }
    });

    it('keeps dependencies before their callers in reading order when wrapping', () => {
      // 150 leaves called by 150 callers: two layers, both wider than a row
      const leaves = keys.slice(0, 150);
      const callers = leaves.map((k) => `c-${k}`);
      const d = new Map(callers.map((c, i) => [c, [leaves[i]]]));
      const { pos } = layoutGraph({ keys: [...leaves, ...callers], deps: d, wrapAspect: 1.6 });
      const at = (k: string) => pos.get(k) as { x: number; y: number };
      for (let i = 0; i < callers.length; i++) {
        const leaf = at(leaves[i]);
        const caller = at(callers[i]);
        expect(caller.y > leaf.y || (caller.y === leaf.y && caller.x > leaf.x)).toBe(true);
      }
    });
  });
});
