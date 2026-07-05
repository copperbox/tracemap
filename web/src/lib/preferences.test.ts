import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREFS,
  LABEL_ZOOM_FACTOR,
  loadPrefs,
  savePrefs,
} from './preferences';

const KEY = 'tracemap.prefs';

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

describe('loadPrefs', () => {
  it('returns defaults when nothing is stored', () => {
    stubStorage();
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('returns defaults when localStorage is unavailable', () => {
    // No stub at all: accessing localStorage throws in the node test env.
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('parses stored preferences', () => {
    stubStorage({ [KEY]: JSON.stringify({ theme: 'light', labelZoom: 'far', teamGrouping: false }) });
    expect(loadPrefs()).toEqual({ theme: 'light', labelZoom: 'far', teamGrouping: false });
  });

  it('returns defaults for corrupt JSON', () => {
    stubStorage({ [KEY]: '{not json' });
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('falls back field-by-field for unknown enum values', () => {
    stubStorage({ [KEY]: JSON.stringify({ theme: 'light', labelZoom: 'bogus' }) });
    expect(loadPrefs()).toEqual({ theme: 'light', labelZoom: 'default', teamGrouping: true });
  });

  it('fills missing fields with defaults', () => {
    stubStorage({ [KEY]: JSON.stringify({ theme: 'light' }) });
    expect(loadPrefs()).toEqual({ theme: 'light', labelZoom: 'default', teamGrouping: true });
  });

  it('defaults team grouping on, and ignores a non-boolean value', () => {
    expect(DEFAULT_PREFS.teamGrouping).toBe(true);
    stubStorage({ [KEY]: JSON.stringify({ teamGrouping: 'nope' }) });
    expect(loadPrefs().teamGrouping).toBe(true);
  });
});

describe('savePrefs', () => {
  it('round-trips through load', () => {
    stubStorage();
    savePrefs({ theme: 'light', labelZoom: 'close', teamGrouping: false });
    expect(loadPrefs()).toEqual({ theme: 'light', labelZoom: 'close', teamGrouping: false });
  });

  it('writes under the stable storage key', () => {
    const store = stubStorage();
    savePrefs(DEFAULT_PREFS);
    expect(store.has(KEY)).toBe(true);
  });

  it('swallows storage errors', () => {
    expect(() => savePrefs(DEFAULT_PREFS)).not.toThrow();
  });
});

describe('LABEL_ZOOM_FACTOR', () => {
  it('keeps the default level at the current behavior', () => {
    expect(LABEL_ZOOM_FACTOR.default).toBe(1);
  });

  it('never hides labels on "always"', () => {
    expect(LABEL_ZOOM_FACTOR.always).toBe(0);
  });

  it('orders levels from earliest to latest label reveal', () => {
    expect(LABEL_ZOOM_FACTOR.always).toBeLessThan(LABEL_ZOOM_FACTOR.far);
    expect(LABEL_ZOOM_FACTOR.far).toBeLessThan(LABEL_ZOOM_FACTOR.default);
    expect(LABEL_ZOOM_FACTOR.default).toBeLessThan(LABEL_ZOOM_FACTOR.close);
  });
});
