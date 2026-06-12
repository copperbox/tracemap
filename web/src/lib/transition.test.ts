import { describe, expect, it } from 'vitest';
import type { GraphNode } from './grouping';
import { computeGraphTransition, type GraphSnapshot, type Pos } from './transition';

const node = (key: string, kind: 'service' | 'group' = 'service', memberIds: string[] = []): GraphNode => ({
  key,
  kind,
  serviceId: kind === 'service' ? key : undefined,
  teamId: 1,
  label: key,
  type: kind === 'group' ? 'group' : 'service',
  status: 'ok',
  rps: 1,
  p95: 10,
  errPct: 0,
  stale: false,
  isExternal: false,
  memberIds,
});

const snap = (nodes: GraphNode[], pos: Record<string, Pos>, edgeKeys: string[] = []): GraphSnapshot => ({
  nodes,
  pos: new Map(Object.entries(pos)),
  edgeKeys: new Set(edgeKeys),
});

// center-alignment offset between the group card (206x96) and a service card (188x74)
const CX = (206 - 188) / 2; // 9
const CY = (96 - 74) / 2; // 11

describe('computeGraphTransition', () => {
  it('glides surviving nodes whose position changed and leaves unmoved ones alone', () => {
    const a = node('a');
    const b = node('b');
    const tr = computeGraphTransition(
      snap([a, b], { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }),
      snap([a, b], { a: { x: 0, y: 0 }, b: { x: 300, y: 200 } }),
    );
    expect(tr.from.get('b')).toEqual({ x: 100, y: 0 });
    expect(tr.from.has('a')).toBe(false);
    expect(tr.appear.size).toBe(0);
    expect(tr.ghosts).toHaveLength(0);
  });

  it('grouping: members become ghosts converging on the new group, which fades in', () => {
    const a = node('a');
    const b = node('b');
    const g = node('group:1', 'group', ['a', 'b']);
    const tr = computeGraphTransition(
      snap([a, b], { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }),
      snap([g], { 'group:1': { x: 200, y: 100 } }),
    );
    expect(tr.appear.has('group:1')).toBe(true);
    expect(tr.from.size).toBe(0);
    expect(tr.ghosts).toHaveLength(2);
    const ghostA = tr.ghosts.find((x) => x.node.key === 'a');
    expect(ghostA?.from).toEqual({ x: 0, y: 0 });
    expect(ghostA?.to).toEqual({ x: 200 + CX, y: 100 + CY });
  });

  it('ungrouping: members fly out of the old group position; the group fades in place', () => {
    const a = node('a');
    const b = node('b');
    const g = node('group:1', 'group', ['a', 'b']);
    const tr = computeGraphTransition(
      snap([g], { 'group:1': { x: 200, y: 100 } }),
      snap([a, b], { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }),
    );
    expect(tr.from.get('a')).toEqual({ x: 200 + CX, y: 100 + CY });
    expect(tr.from.get('b')).toEqual({ x: 200 + CX, y: 100 + CY });
    expect(tr.appear.size).toBe(0);
    expect(tr.ghosts).toHaveLength(1);
    expect(tr.ghosts[0].node.key).toBe('group:1');
    expect(tr.ghosts[0].from).toEqual(tr.ghosts[0].to);
  });

  it('nodes with no counterpart fade in at their target / fade out in place', () => {
    const a = node('a');
    const b = node('b');
    const tr = computeGraphTransition(
      snap([a], { a: { x: 0, y: 0 } }),
      snap([b], { b: { x: 50, y: 50 } }),
    );
    expect(tr.appear.has('b')).toBe(true);
    expect(tr.from.size).toBe(0);
    expect(tr.ghosts).toHaveLength(1);
    expect(tr.ghosts[0].node.key).toBe('a');
    expect(tr.ghosts[0].from).toEqual({ x: 0, y: 0 });
    expect(tr.ghosts[0].to).toEqual({ x: 0, y: 0 });
  });

  it('only edges new to the next graph fade in', () => {
    const a = node('a');
    const b = node('b');
    const tr = computeGraphTransition(
      snap([a, b], { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }, ['a=>b']),
      snap([a, b], { a: { x: 0, y: 0 }, b: { x: 100, y: 100 } }, ['a=>b', 'b=>a']),
    );
    expect([...tr.newEdges]).toEqual(['b=>a']);
  });

  it('skips nodes without a known position', () => {
    const a = node('a');
    const b = node('b');
    const tr = computeGraphTransition(snap([a], {}), snap([b], {}));
    expect(tr.from.size).toBe(0);
    expect(tr.appear.size).toBe(0);
    expect(tr.ghosts).toHaveLength(0);
  });
});
