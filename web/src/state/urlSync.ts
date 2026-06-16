import { useStore } from './store';
import { routeToUrl, urlToRoute, type RouteState } from './routing';

/** The address-bar path + query the app currently reflects. */
function currentUrl(): string {
  return window.location.pathname + window.location.search;
}

/** Pull the deep-linkable slice out of the live store. */
function routeFromStore(): RouteState {
  const s = useStore.getState();
  return {
    view: s.view,
    serviceId: s.serviceId,
    graphType: s.graphType,
    openTraceId: s.openTraceId,
    range: s.range,
    teamFilter: s.teamFilter,
    isolateId: s.isolateId,
  };
}

/**
 * Two-way bind the store's navigation slice to the browser URL:
 *   - hydrate the store from the current location on startup,
 *   - push/replace history entries as the user navigates,
 *   - apply the URL back to the store on browser back/forward.
 *
 * Call once, before the first render, so the correct view paints immediately
 * on a deep-linked reload instead of flashing the default map.
 */
export function initRouting(): void {
  // 1. Hydrate the store from the initial URL, then normalise the address bar
  //    so a messy hand-typed link (extra params, default values) becomes
  //    canonical without adding a history entry.
  useStore.getState().applyRoute(urlToRoute(currentUrl()));
  window.history.replaceState(null, '', routeToUrl(routeFromStore()));

  // 2. Browser back/forward -> store. The resulting store update recomputes the
  //    same URL, so the subscriber below sees no diff and does not re-push.
  window.addEventListener('popstate', () => {
    useStore.getState().applyRoute(urlToRoute(currentUrl()));
  });

  // 3. Store -> URL. Path/trace changes are genuine navigations and get their
  //    own history entry; filter-only tweaks (range/team) just rewrite the
  //    current entry so the back button isn't cluttered with every adjustment.
  useStore.subscribe((state, prev) => {
    const url = routeToUrl(routeFromStore());
    if (url === currentUrl()) return;
    const navChanged =
      state.view !== prev.view ||
      state.serviceId !== prev.serviceId ||
      state.graphType !== prev.graphType ||
      state.openTraceId !== prev.openTraceId ||
      state.isolateId !== prev.isolateId;
    if (navChanged) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
  });
}
