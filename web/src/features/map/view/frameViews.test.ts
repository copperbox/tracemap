import { describe, expect, it } from 'vitest';
import { FRAME_PAD, FRAME_TITLE_H } from '../../../lib/clusterLayout';
import type { GraphNode } from '../../../lib/grouping';
import { NODE_H, NODE_W } from '../../../lib/layout';
import type { Pos } from '../../../lib/transition';
import { buildFrameViews } from './frameViews';

const node = (over: Partial<GraphNode> = {}): GraphNode => ({
  key: 'svc-a',
  kind: 'service',
  teamId: 1,
  teamName: null,
  label: 'svc-a',
  type: 'service',
  status: 'ok',
  rps: 1,
  p95: 10,
  errPct: 0,
  stale: false,
  isExternal: false,
  memberIds: [],
  ...over,
});

const team = { id: 1, name: 'Payments' };
const posMap = (entries: Record<string, Pos>) => (key: string) => entries[key];
const never = () => false;

describe('buildFrameViews', () => {
  it('returns nothing for a team without service nodes', () => {
    expect(buildFrameViews([team], [node({ teamId: 2 })], posMap({}), never)).toEqual([]);
  });

  it('ignores group meganodes (merged teams get no frame)', () => {
    const group = node({ key: 'group:1', kind: 'group', memberIds: ['svc-a'] });
    expect(buildFrameViews([team], [group], posMap({ 'group:1': { x: 0, y: 0 } }), never)).toEqual([]);
  });

  it('returns nothing when no member has a position yet', () => {
    expect(buildFrameViews([team], [node()], posMap({}), never)).toEqual([]);
  });

  it('pads the members bounding box with the frame padding and title bar', () => {
    const nodes = [node(), node({ key: 'svc-b', label: 'svc-b' })];
    const [f] = buildFrameViews(
      [team],
      nodes,
      posMap({ 'svc-a': { x: 0, y: 0 }, 'svc-b': { x: 100, y: 50 } }),
      never,
    );
    expect(f).toEqual({
      teamId: 1,
      name: 'Payments',
      memberKeys: ['svc-a', 'svc-b'],
      x: -FRAME_PAD,
      y: -FRAME_TITLE_H,
      w: 100 + NODE_W + 2 * FRAME_PAD,
      h: 50 + NODE_H + FRAME_TITLE_H + FRAME_PAD,
      dim: false,
    });
  });

  it('only includes members of the frame team', () => {
    const nodes = [node(), node({ key: 'svc-x', teamId: 2 })];
    const [f] = buildFrameViews(
      [team],
      nodes,
      posMap({ 'svc-a': { x: 0, y: 0 }, 'svc-x': { x: 999, y: 999 } }),
      never,
    );
    expect(f.memberKeys).toEqual(['svc-a']);
    expect(f.w).toBe(NODE_W + 2 * FRAME_PAD);
  });

  it('dims the frame only when every member is dimmed', () => {
    const nodes = [node(), node({ key: 'svc-b' })];
    const pos = posMap({ 'svc-a': { x: 0, y: 0 }, 'svc-b': { x: 10, y: 10 } });
    expect(buildFrameViews([team], nodes, pos, (k) => k === 'svc-a')[0].dim).toBe(false);
    expect(buildFrameViews([team], nodes, pos, () => true)[0].dim).toBe(true);
  });
});
