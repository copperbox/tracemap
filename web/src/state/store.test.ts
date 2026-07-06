import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { urlToRoute } from './routing';

// Reset the transient navigation slice before each case so tests don't leak
// state into one another (zustand stores are module singletons).
beforeEach(() => {
  useStore.setState({ view: 'map', serviceId: null, serviceOpFilter: null });
});

describe('navigate', () => {
  it('carries an operation filter to the service detail page', () => {
    useStore.getState().navigate('service', 'checkout', 'POST /charge');
    const s = useStore.getState();
    expect(s.view).toBe('service');
    expect(s.serviceId).toBe('checkout');
    expect(s.serviceOpFilter).toBe('POST /charge');
  });

  it('clears any pending operation filter when navigating without one', () => {
    useStore.setState({ serviceOpFilter: 'POST /charge' });
    useStore.getState().navigate('service', 'checkout');
    expect(useStore.getState().serviceOpFilter).toBeNull();
  });
});

describe('applyRoute', () => {
  it('clears any stale operation filter, since it is transient and not routable', () => {
    useStore.setState({ serviceOpFilter: 'POST /charge' });
    useStore.getState().applyRoute(urlToRoute('/service/api'));
    const s = useStore.getState();
    expect(s.serviceId).toBe('api');
    expect(s.serviceOpFilter).toBeNull();
  });
});
