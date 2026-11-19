import { describe, expect, it } from 'vitest';
import { watchPixelRatio } from './pixelRatio';

/** A window whose matchMedia lists can be fired by hand. */
function fakeWindow(dpr: number) {
  const lists: { query: string; fns: Set<() => void> }[] = [];
  const win = {
    devicePixelRatio: dpr,
    matchMedia: (query: string) => {
      const fns = new Set<() => void>();
      lists.push({ query, fns });
      return {
        addEventListener: (_: string, fn: () => void) => fns.add(fn),
        removeEventListener: (_: string, fn: () => void) => fns.delete(fn),
      } as unknown as MediaQueryList;
    },
  };
  const moveTo = (next: number): void => {
    win.devicePixelRatio = next;
    for (const l of [...lists]) for (const fn of [...l.fns]) fn();
  };
  const live = () => lists.filter((l) => l.fns.size > 0).map((l) => l.query);
  return { win, moveTo, live };
}

describe('watchPixelRatio', () => {
  it('reports each new ratio and re-arms for it', () => {
    const f = fakeWindow(1);
    const seen: number[] = [];
    const stop = watchPixelRatio(f.win, (d) => seen.push(d));
    expect(f.live()).toEqual(['(resolution: 1dppx)']);
    f.moveTo(2);
    f.moveTo(1.5);
    expect(seen).toEqual([2, 1.5]);
    expect(f.live()).toEqual(['(resolution: 1.5dppx)']);
    stop();
    expect(f.live()).toEqual([]);
  });
});
