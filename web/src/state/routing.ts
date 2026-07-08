import type { GraphType, View } from './store';
import { DEFAULT_RANGE, QUICK_RANGES, type TimeRange } from '../lib/timerange';
import type { TeamFilterValue } from '../lib/teamFilter';

/**
 * The slice of app state that is reflected in the browser URL and can be
 * deep-linked / restored on reload. Everything in here round-trips through
 * `routeToUrl` <-> `urlToRoute`; transient UI state (selection, hover, search,
 * merged teams, theme) deliberately stays out of the URL.
 *
 * URL shape:
 *   /                     map view, layered graph
 *   /communities          map view, force/communities graph
 *   /services             services list
 *   /service/<id>         service detail
 *   /wallboard            wallboard (one card per service)
 *   ?trace=<id>           trace modal overlay (on any view)
 *   ?range=q.<ms>         quick time range (omitted when it equals the default)
 *   ?range=a.<from>.<to>  absolute time range (epoch ms)
 *   ?team=none|<id>       team filter (omitted when "all")
 *   ?isolate=<key>        render only this node/group/edge's dependency tree
 *                         (layered map only -- ignored on every other view)
 */
export interface RouteState {
  view: View;
  serviceId: string | null;
  graphType: GraphType;
  openTraceId: string | null;
  range: TimeRange;
  teamFilter: TeamFilterValue;
  /** Isolated dependency-tree key; only meaningful on the layered map ("/"). */
  isolateId: string | null;
}

// ---------------------------------------------------------------------------
// TimeRange <-> string
// ---------------------------------------------------------------------------

function rangesEqual(a: TimeRange, b: TimeRange): boolean {
  if (a.kind === 'quick' && b.kind === 'quick') return a.ms === b.ms;
  if (a.kind === 'absolute' && b.kind === 'absolute') return a.from === b.from && a.to === b.to;
  return false;
}

/** Fallback label for a quick range whose ms is not one of the known presets
 *  (only reachable via a hand-edited URL -- the picker always uses presets). */
function quickLabel(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins % 1440 === 0) return `Last ${mins / 1440} days`;
  if (mins % 60 === 0) return `Last ${mins / 60} hours`;
  return `Last ${mins} minutes`;
}

function encodeRange(r: TimeRange): string | null {
  // The default range stays out of the URL so shared links read cleanly.
  if (rangesEqual(r, DEFAULT_RANGE)) return null;
  if (r.kind === 'quick') return `q.${r.ms}`;
  return `a.${r.from}.${r.to}`;
}

function decodeRange(raw: string | null): TimeRange {
  if (!raw) return DEFAULT_RANGE;
  const [kind, a, b] = raw.split('.');
  if (kind === 'q') {
    const ms = Number(a);
    if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_RANGE;
    const preset = QUICK_RANGES.find((q) => q.ms === ms);
    return { kind: 'quick', label: preset?.label ?? quickLabel(ms), ms };
  }
  if (kind === 'a') {
    const from = Number(a);
    const to = Number(b);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return DEFAULT_RANGE;
    return { kind: 'absolute', from, to };
  }
  return DEFAULT_RANGE;
}

// ---------------------------------------------------------------------------
// TeamFilterValue <-> string
// ---------------------------------------------------------------------------

function encodeTeam(t: TeamFilterValue): string | null {
  if (t === 'all') return null; // default -> omit
  if (t === 'none') return 'none';
  return String(t);
}

function decodeTeam(raw: string | null): TeamFilterValue {
  if (!raw || raw === 'all') return 'all';
  if (raw === 'none') return 'none';
  const n = Number(raw);
  return Number.isInteger(n) ? n : 'all';
}

// ---------------------------------------------------------------------------
// Route <-> URL
// ---------------------------------------------------------------------------

/** Build the canonical "/path?query" string for a route state. */
export function routeToUrl(s: RouteState): string {
  let path: string;
  if (s.view === 'service' && s.serviceId) {
    path = `/service/${encodeURIComponent(s.serviceId)}`;
  } else if (s.view === 'services') {
    path = '/services';
  } else if (s.view === 'wallboard') {
    path = '/wallboard';
  } else if (s.view === 'map' && s.graphType === 'communities') {
    path = '/communities';
  } else {
    path = '/';
  }

  const params = new URLSearchParams();
  if (s.openTraceId) params.set('trace', s.openTraceId);
  const range = encodeRange(s.range);
  if (range) params.set('range', range);
  const team = encodeTeam(s.teamFilter);
  if (team) params.set('team', team);
  // Isolation only renders on the layered map, so it never appears on any other
  // path (the store may still hold an id from before a view switch).
  if (s.view === 'map' && s.graphType === 'map' && s.isolateId) params.set('isolate', s.isolateId);

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** Parse a "/path?query" string into a fully-populated route state. Unknown or
 *  malformed input degrades gracefully to the map view with default filters. */
export function urlToRoute(url: string): RouteState {
  const [rawPath, rawQuery = ''] = url.split('?');
  const segs = rawPath.split('/').filter(Boolean);
  const params = new URLSearchParams(rawQuery);

  let view: View = 'map';
  let serviceId: string | null = null;
  let graphType: GraphType = 'map';

  if (segs[0] === 'services') {
    view = 'services';
  } else if (segs[0] === 'wallboard') {
    view = 'wallboard';
  } else if (segs[0] === 'service') {
    serviceId = segs[1] ? decodeURIComponent(segs[1]) : null;
    // /service with no id is meaningless -> fall back to the map.
    view = serviceId ? 'service' : 'map';
  } else if (segs[0] === 'communities') {
    graphType = 'communities';
  }

  // Isolation is a layered-map concept; ignore the param anywhere else so a
  // stray ?isolate on, say, /communities does not resurrect a removed tree.
  const isolateId = view === 'map' && graphType === 'map' ? params.get('isolate') : null;

  return {
    view,
    serviceId,
    graphType,
    openTraceId: params.get('trace'),
    range: decodeRange(params.get('range')),
    teamFilter: decodeTeam(params.get('team')),
    isolateId,
  };
}
