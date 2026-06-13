import { useEffect, useReducer, useRef, type Reducer } from 'react';
import {
  initialResource,
  resourceReducer,
  type ResourceAction,
  type ResourceState,
} from './resource';

interface UseResourceOpts {
  /** Re-runs the fetch whenever any of these change (e.g. [serviceId, range]). */
  deps: unknown[];
  /** When this changes, stale data is dropped so the skeleton shows again. */
  resetKey?: unknown;
  /** Skip fetching while false (e.g. no service selected yet). */
  enabled?: boolean;
  /** Poll on an interval while true (used for live ranges). */
  live?: boolean;
  intervalMs?: number;
}

/**
 * Drives one async resource with its own loading/error state so each section of
 * a page can load and reveal independently. A live refresh keeps the previous
 * data on screen; only a resetKey change (a new identity) clears it back to a
 * skeleton.
 */
export function useResource<T>(
  fetcher: () => Promise<T>,
  { deps, resetKey, enabled = true, live = false, intervalMs = 30_000 }: UseResourceOpts,
): ResourceState<T> {
  const reducer = resourceReducer as Reducer<ResourceState<T>, ResourceAction<T>>;
  const [state, dispatch] = useReducer(reducer, undefined, initialResource<T>);

  // Always call the latest fetcher (callers pass a fresh closure each render)
  // while letting `deps` decide explicitly when to re-fetch.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    dispatch({ type: 'reset' });
  }, [resetKey]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      dispatch({ type: 'start' });
      try {
        const data = await fetcherRef.current();
        if (alive) dispatch({ type: 'success', data });
      } catch (err) {
        if (alive) dispatch({ type: 'error', message: (err as Error).message });
      }
    };
    void load();
    const timer = live ? setInterval(load, intervalMs) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, live, intervalMs, ...deps]);

  return state;
}
