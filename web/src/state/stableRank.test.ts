import { describe, expect, it } from 'vitest';
import type { Status } from '../api/types';
import { RERANK_MS, stableRank } from './stableRank';

const r = (id: string, status: Status = 'ok', rps = 1) => ({ id, status, rps });
const ids = (rows: { id: string }[]) => rows.map((x) => x.id);

describe('stableRank', () => {
  const first = stableRank(null, [r('a'), r('b'), r('c')], 0, false);

  it('takes the fresh ranking the first time', () => {
    expect(ids(first.rows)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the order when only the numbers moved', () => {
    const next = stableRank(first.state, [r('c'), r('a'), r('b')], 2000, false);
    expect(ids(next.rows)).toEqual(['a', 'b', 'c']);
    expect(next.state).toBe(first.state);
  });

  it('re-ranks once the interval has passed', () => {
    expect(ids(stableRank(first.state, [r('c'), r('a'), r('b')], RERANK_MS, false).rows)).toEqual(['c', 'a', 'b']);
  });

  it('moves a service to its new band at once, and only that service', () => {
    const next = stableRank(first.state, [r('c', 'crit'), r('b', 'ok', 50), r('a')], 2000, false);
    expect(ids(next.rows)).toEqual(['c', 'a', 'b']);
    // the move is recorded, so the next frame keeps it without moving again
    expect(ids(stableRank(next.state, [r('c', 'crit'), r('b', 'ok', 50), r('a')], 4000, false).rows)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('puts a recovered service at the head of its new band', () => {
    const s = stableRank(null, [r('x', 'crit'), r('y', 'warn'), r('a'), r('b')], 0, false).state;
    expect(ids(stableRank(s, [r('y', 'warn'), r('a'), r('b'), r('x', 'ok', 5)], 2000, false).rows)).toEqual([
      'y',
      'x',
      'a',
      'b',
    ]);
  });

  it('re-ranks when the listed set changes (search, filter)', () => {
    expect(ids(stableRank(first.state, [r('c'), r('a')], 2000, false).rows)).toEqual(['c', 'a']);
  });

  it('never re-ranks while held, and catches up on release', () => {
    const held = stableRank(first.state, [r('c', 'crit'), r('a'), r('b')], RERANK_MS * 2, true);
    expect(ids(held.rows)).toEqual(['a', 'b', 'c']);
    expect(held.rows[2].status).toBe('crit'); // values stay live
    const released = stableRank(held.state, [r('c', 'crit'), r('a'), r('b')], RERANK_MS * 2, false);
    expect(ids(released.rows)).toEqual(['c', 'a', 'b']);
  });

  it('while held, drops removed rows and appends new ones', () => {
    const held = stableRank(first.state, [r('d', 'crit'), r('c'), r('a')], 2000, true);
    expect(ids(held.rows)).toEqual(['a', 'c', 'd']);
    const again = stableRank(held.state, [r('d', 'crit'), r('c'), r('a')], 4000, true);
    expect(ids(again.rows)).toEqual(['a', 'c', 'd']);
  });
});
