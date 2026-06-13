import { describe, expect, it } from 'vitest';
import { initialResource, resourcePhase, resourceReducer } from './resource';

describe('resourceReducer', () => {
  it('starts loading with no data or error', () => {
    const s = initialResource<number>();
    expect(s).toEqual({ data: null, error: null, loading: true });
    expect(resourcePhase(s)).toBe('loading');
  });

  it('success stores data and clears loading/error', () => {
    const s = resourceReducer(initialResource<number>(), { type: 'success', data: 42 });
    expect(s).toEqual({ data: 42, error: null, loading: false });
    expect(resourcePhase(s)).toBe('ready');
  });

  it('treats an empty array result as ready, not loading', () => {
    const s = resourceReducer(initialResource<number[]>(), { type: 'success', data: [] });
    expect(resourcePhase(s)).toBe('ready');
  });

  it('error before any data surfaces the error', () => {
    const s = resourceReducer(initialResource<number>(), { type: 'error', message: 'boom' });
    expect(s).toEqual({ data: null, error: 'boom', loading: false });
    expect(resourcePhase(s)).toBe('error');
  });

  it('keeps the last good data when a refresh fails', () => {
    const ok = resourceReducer(initialResource<number>(), { type: 'success', data: 7 });
    const failed = resourceReducer(ok, { type: 'error', message: 'network' });
    expect(failed).toEqual({ data: 7, error: 'network', loading: false });
    // Data still present, so consumers keep rendering it rather than the error.
    expect(resourcePhase(failed)).toBe('ready');
  });

  it('start does not drop data while a live refresh is in flight', () => {
    const ok = resourceReducer(initialResource<number>(), { type: 'success', data: 7 });
    const refreshing = resourceReducer(ok, { type: 'start' });
    expect(refreshing.data).toBe(7);
    expect(resourcePhase(refreshing)).toBe('ready');
  });

  it('reset drops stale data so the skeleton returns', () => {
    const ok = resourceReducer(initialResource<number>(), { type: 'success', data: 7 });
    const reset = resourceReducer(ok, { type: 'reset' });
    expect(reset).toEqual({ data: null, error: null, loading: true });
    expect(resourcePhase(reset)).toBe('loading');
  });

  it('recovers to ready after a success following an error', () => {
    const failed = resourceReducer(initialResource<number>(), { type: 'error', message: 'x' });
    const recovered = resourceReducer(failed, { type: 'success', data: 1 });
    expect(recovered).toEqual({ data: 1, error: null, loading: false });
    expect(resourcePhase(recovered)).toBe('ready');
  });
});
