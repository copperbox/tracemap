import { describe, expect, it } from 'vitest';
import { routeToUrl, urlToRoute, type RouteState } from './routing';
import { DEFAULT_RANGE } from '../lib/timerange';

const base: RouteState = {
  view: 'map',
  serviceId: null,
  graphType: 'map',
  openTraceId: null,
  range: DEFAULT_RANGE,
  teamFilter: 'all',
  isolateId: null,
};

const route = (over: Partial<RouteState>): RouteState => ({ ...base, ...over });

describe('routeToUrl', () => {
  it('maps the default map view to "/"', () => {
    expect(routeToUrl(base)).toBe('/');
  });

  it('encodes the communities graph as a path', () => {
    expect(routeToUrl(route({ view: 'map', graphType: 'communities' }))).toBe('/communities');
  });

  it('encodes the services list', () => {
    expect(routeToUrl(route({ view: 'services' }))).toBe('/services');
  });

  it('encodes a service detail with its id', () => {
    expect(routeToUrl(route({ view: 'service', serviceId: 'checkout' }))).toBe('/service/checkout');
  });

  it('url-encodes service ids with special characters', () => {
    expect(routeToUrl(route({ view: 'service', serviceId: 'cart/v2 svc' }))).toBe(
      '/service/cart%2Fv2%20svc',
    );
  });

  it('falls back to "/" when a service view has no id', () => {
    expect(routeToUrl(route({ view: 'service', serviceId: null }))).toBe('/');
  });

  it('adds the open trace as a query param', () => {
    expect(routeToUrl(route({ view: 'service', serviceId: 'api', openTraceId: 'abc123' }))).toBe(
      '/service/api?trace=abc123',
    );
  });

  it('omits the default range and the "all" team filter', () => {
    expect(routeToUrl(base)).toBe('/');
  });

  it('encodes a non-default quick range', () => {
    expect(routeToUrl(route({ range: { kind: 'quick', label: 'Last 1 hour', ms: 3_600_000 } }))).toBe(
      '/?range=q.3600000',
    );
  });

  it('encodes an absolute range', () => {
    expect(routeToUrl(route({ range: { kind: 'absolute', from: 1000, to: 2000 } }))).toBe(
      '/?range=a.1000.2000',
    );
  });

  it('encodes the team filter (numeric and none)', () => {
    expect(routeToUrl(route({ teamFilter: 7 }))).toBe('/?team=7');
    expect(routeToUrl(route({ teamFilter: 'none' }))).toBe('/?team=none');
  });

  it('encodes an isolated node tree on the layered map', () => {
    expect(routeToUrl(route({ isolateId: 'checkout' }))).toBe('/?isolate=checkout');
  });

  it('url-encodes an isolated edge key', () => {
    expect(routeToUrl(route({ isolateId: 'api=>db' }))).toBe('/?isolate=api%3D%3Edb');
  });

  it('omits isolate on the communities graph', () => {
    expect(routeToUrl(route({ graphType: 'communities', isolateId: 'checkout' }))).toBe('/communities');
  });

  it('omits isolate on a non-map view', () => {
    expect(routeToUrl(route({ view: 'service', serviceId: 'api', isolateId: 'api' }))).toBe(
      '/service/api',
    );
  });
});

describe('urlToRoute', () => {
  it('parses "/" as the default map view', () => {
    expect(urlToRoute('/')).toEqual(base);
  });

  it('parses the communities path', () => {
    expect(urlToRoute('/communities')).toEqual(route({ graphType: 'communities' }));
  });

  it('parses the services list', () => {
    expect(urlToRoute('/services')).toEqual(route({ view: 'services' }));
  });

  it('parses a service detail and decodes its id', () => {
    expect(urlToRoute('/service/cart%2Fv2%20svc')).toEqual(
      route({ view: 'service', serviceId: 'cart/v2 svc' }),
    );
  });

  it('treats /service with no id as the map view', () => {
    expect(urlToRoute('/service')).toEqual(base);
    expect(urlToRoute('/service/')).toEqual(base);
  });

  it('reads the trace, range and team query params', () => {
    expect(urlToRoute('/service/api?trace=abc&range=q.3600000&team=5')).toEqual(
      route({
        view: 'service',
        serviceId: 'api',
        openTraceId: 'abc',
        range: { kind: 'quick', label: 'Last 1 hour', ms: 3_600_000 },
        teamFilter: 5,
      }),
    );
  });

  it('parses an absolute range', () => {
    expect(urlToRoute('/?range=a.1000.2000').range).toEqual({ kind: 'absolute', from: 1000, to: 2000 });
  });

  it('falls back to the default range for malformed input', () => {
    expect(urlToRoute('/?range=garbage').range).toEqual(DEFAULT_RANGE);
    expect(urlToRoute('/?range=q.notanumber').range).toEqual(DEFAULT_RANGE);
    expect(urlToRoute('/?range=a.1').range).toEqual(DEFAULT_RANGE);
  });

  it('reconstructs a sensible label for an unknown quick range ms', () => {
    const r = urlToRoute('/?range=q.120000').range;
    expect(r).toEqual({ kind: 'quick', label: 'Last 2 minutes', ms: 120000 });
  });

  it('falls back to "all" for an unknown team filter', () => {
    expect(urlToRoute('/?team=bogus').teamFilter).toBe('all');
  });

  it('reads the isolate param on the layered map', () => {
    expect(urlToRoute('/?isolate=checkout').isolateId).toBe('checkout');
    expect(urlToRoute('/?isolate=api%3D%3Edb').isolateId).toBe('api=>db');
  });

  it('ignores the isolate param off the layered map', () => {
    expect(urlToRoute('/communities?isolate=checkout').isolateId).toBeNull();
    expect(urlToRoute('/service/api?isolate=api').isolateId).toBeNull();
  });

  it('degrades an unknown path to the map view', () => {
    expect(urlToRoute('/nope/here')).toEqual(base);
  });
});

describe('routeToUrl <-> urlToRoute round trips', () => {
  const cases: RouteState[] = [
    base,
    route({ graphType: 'communities' }),
    route({ view: 'services' }),
    route({ view: 'service', serviceId: 'checkout-service' }),
    route({ view: 'service', serviceId: 'a/b c', openTraceId: 'deadbeef' }),
    route({ range: { kind: 'quick', label: 'Last 1 hour', ms: 3_600_000 } }),
    route({ range: { kind: 'absolute', from: 111, to: 222 } }),
    route({ teamFilter: 'none' }),
    route({ teamFilter: 42 }),
    route({ view: 'service', serviceId: 'api', teamFilter: 3, openTraceId: 't1' }),
    route({ isolateId: 'checkout' }),
    route({ isolateId: 'group:3' }),
    route({ isolateId: 'api=>db', teamFilter: 5 }),
  ];

  it.each(cases)('round-trips %o', (r) => {
    expect(urlToRoute(routeToUrl(r))).toEqual(r);
  });
});
