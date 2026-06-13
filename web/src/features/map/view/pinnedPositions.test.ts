import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPinnedPositions, loadPinnedPositions, savePinnedPositions } from './pinnedPositions';

const KEY = 'tracemap.nodePositions';

function stubStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadPinnedPositions', () => {
  it('returns an empty record when nothing is stored', () => {
    stubStorage();
    expect(loadPinnedPositions()).toEqual({});
  });

  it('parses stored positions', () => {
    stubStorage({ [KEY]: JSON.stringify({ a: { x: 1, y: 2 } }) });
    expect(loadPinnedPositions()).toEqual({ a: { x: 1, y: 2 } });
  });

  it('returns an empty record for corrupt JSON', () => {
    stubStorage({ [KEY]: '{not json' });
    expect(loadPinnedPositions()).toEqual({});
  });
});

describe('savePinnedPositions', () => {
  it('round-trips through load', () => {
    stubStorage();
    savePinnedPositions({ 'group:1': { x: -10, y: 40.5 } });
    expect(loadPinnedPositions()).toEqual({ 'group:1': { x: -10, y: 40.5 } });
  });

  it('writes under the stable storage key', () => {
    const store = stubStorage();
    savePinnedPositions({});
    expect(store.has(KEY)).toBe(true);
  });
});

describe('clearPinnedPositions', () => {
  it('removes the stored entry', () => {
    const store = stubStorage({ [KEY]: '{}' });
    clearPinnedPositions();
    expect(store.has(KEY)).toBe(false);
    expect(loadPinnedPositions()).toEqual({});
  });
});
