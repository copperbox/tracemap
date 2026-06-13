import { describe, expect, it } from 'vitest';
import { detectCommunities, type CommunityEdge } from './community';

const e = (sourceKey: string, targetKey: string): CommunityEdge => ({ sourceKey, targetKey });

describe('detectCommunities', () => {
  it('returns nothing for an empty graph', () => {
    const r = detectCommunities([], []);
    expect(r.count).toBe(0);
    expect(r.byNode.size).toBe(0);
  });

  it('puts an isolated node in its own community', () => {
    const r = detectCommunities(['a', 'b'], []);
    expect(r.count).toBe(2);
    expect(r.byNode.get('a')).not.toBe(r.byNode.get('b'));
  });

  it('separates two cliques joined by a single bridge', () => {
    // {a,b,c} clique and {d,e,f} clique, bridged by c-d.
    const edges = [
      e('a', 'b'),
      e('b', 'c'),
      e('a', 'c'),
      e('d', 'e'),
      e('e', 'f'),
      e('d', 'f'),
      e('c', 'd'),
    ];
    const r = detectCommunities(['a', 'b', 'c', 'd', 'e', 'f'], edges);
    expect(r.count).toBe(2);
    // each clique shares one community
    expect(r.byNode.get('a')).toBe(r.byNode.get('b'));
    expect(r.byNode.get('a')).toBe(r.byNode.get('c'));
    expect(r.byNode.get('d')).toBe(r.byNode.get('e'));
    expect(r.byNode.get('d')).toBe(r.byNode.get('f'));
    // the two cliques are distinct
    expect(r.byNode.get('a')).not.toBe(r.byNode.get('d'));
  });

  it('numbers the largest community first', () => {
    // a 4-clique and a 3-clique, no bridge.
    const big = [e('a', 'b'), e('b', 'c'), e('c', 'd'), e('a', 'c'), e('a', 'd'), e('b', 'd')];
    const small = [e('x', 'y'), e('y', 'z'), e('x', 'z')];
    const r = detectCommunities(['a', 'b', 'c', 'd', 'x', 'y', 'z'], [...big, ...small]);
    expect(r.count).toBe(2);
    expect(r.byNode.get('a')).toBe(0); // largest cluster gets id 0
    expect(r.byNode.get('x')).toBe(1);
  });

  it('is deterministic across runs and edge ordering', () => {
    const edges = [e('a', 'b'), e('b', 'c'), e('a', 'c'), e('d', 'e'), e('e', 'f'), e('d', 'f'), e('c', 'd')];
    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    const r1 = detectCommunities(keys, edges);
    const r2 = detectCommunities([...keys].reverse(), [...edges].reverse());
    expect([...r2.byNode.entries()].sort()).toEqual([...r1.byNode.entries()].sort());
  });

  it('ignores self-loops and edges to absent nodes', () => {
    const r = detectCommunities(['a', 'b'], [e('a', 'a'), e('a', 'ghost'), e('a', 'b')]);
    expect(r.count).toBe(1);
    expect(r.byNode.get('a')).toBe(r.byNode.get('b'));
  });
});
