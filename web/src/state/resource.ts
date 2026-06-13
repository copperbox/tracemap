/**
 * Pure state machine for one async resource (a single network fetch). The hook
 * in useResource.ts wires React effects around these transitions; keeping them
 * here makes the loading/error logic unit-testable without a DOM.
 */

export interface ResourceState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

export type ResourceAction<T> =
  | { type: 'reset' }
  | { type: 'start' }
  | { type: 'success'; data: T }
  | { type: 'error'; message: string };

export function initialResource<T>(): ResourceState<T> {
  return { data: null, error: null, loading: true };
}

export function resourceReducer<T>(
  state: ResourceState<T>,
  action: ResourceAction<T>,
): ResourceState<T> {
  switch (action.type) {
    case 'reset':
      // New identity (e.g. a different service): drop stale data so the
      // skeleton shows again instead of last service's numbers.
      return { data: null, error: null, loading: true };
    case 'start':
      // Keep prior data/error so a live refresh doesn't flash a skeleton.
      return { ...state, loading: true };
    case 'success':
      return { data: action.data, error: null, loading: false };
    case 'error':
      // Preserve the last good data; the error only surfaces when there is none.
      return { ...state, error: action.message, loading: false };
    default:
      return state;
  }
}

export type ResourcePhase = 'loading' | 'error' | 'ready';

/**
 * What a consumer should render: data wins (even an empty array), then a
 * first-load error, otherwise the loading skeleton.
 */
export function resourcePhase(state: ResourceState<unknown>): ResourcePhase {
  if (state.data != null) return 'ready';
  if (state.error != null) return 'error';
  return 'loading';
}
