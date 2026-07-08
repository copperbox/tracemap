import { create } from 'zustand';
import type { Topology } from '../api/types';
import { loadPrefs, savePrefs, type LabelZoomLevel, type Theme } from '../lib/preferences';
import type { TeamFilterValue } from '../lib/teamFilter';
import { DEFAULT_RANGE, type TimeRange } from '../lib/timerange';
import type { RouteState } from './routing';

export type View = 'map' | 'services' | 'service' | 'wallboard';
/** How the service map is drawn: layered dependency flow, or a force-directed
 *  graph clustered by detected community. */
export type GraphType = 'map' | 'communities';
export type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string } // "source->target"
  | { kind: 'group'; teamId: number }
  | null;

interface AppState {
  view: View;
  graphType: GraphType;
  serviceId: string | null;
  /**
   * Pending recent-traces operation filter to apply when the service detail
   * page next loads. Set when navigating from an erroring-operation link (e.g.
   * the map drawer's top errors) so the trace list opens already filtered to
   * that operation's failures. Transient -- deliberately kept out of the URL.
   */
  serviceOpFilter: string | null;
  topology: Topology | null;
  selection: Selection;
  hoverEdge: string | null;
  focusId: string | null; // node id, "group:<teamId>", or edge key "<src>=><tgt>"
  /**
   * The dependency tree to render in isolation: same key shape as focusId, but
   * instead of dimming the rest, everything outside the tree is removed from the
   * layout entirely. Layered map only -- the communities view ignores it.
   */
  isolateId: string | null;
  search: string;
  teamFilter: TeamFilterValue;
  /** Teams currently collapsed into a single meganode on the map. */
  mergedTeams: number[];
  theme: Theme;
  /** Required zoom before map node labels render (user preference, persisted). */
  labelZoom: LabelZoomLevel;
  /** Whether the map wraps each team's services in a merge-able container
   *  (user preference, persisted). Off draws every service individually with
   *  its owning team as a subtitle. */
  teamGrouping: boolean;
  tick: number;
  range: TimeRange;
  openTraceId: string | null;
  ingesting: boolean;

  setTopology: (t: Topology) => void;
  /** Switch views; when going to a service, `opFilter` pre-filters its recent
   *  traces to that operation's failures. */
  navigate: (view: View, serviceId?: string, opFilter?: string) => void;
  /** Apply a deep-link route in one update (used by the URL <-> store sync on
   *  initial load and on browser back/forward). */
  applyRoute: (route: RouteState) => void;
  setGraphType: (g: GraphType) => void;
  select: (sel: Selection) => void;
  setHoverEdge: (id: string | null) => void;
  setFocus: (id: string | null) => void;
  setIsolate: (id: string | null) => void;
  /** Jump to the layered map showing only the dependency tree of `id`. */
  isolateOnMap: (id: string) => void;
  /** Jump to the full layered map with `id` selected -- opens its drawer and
   *  pans the camera to it. Used by the header health-count popovers so a
   *  responder goes from a count straight to the offending service. */
  revealOnMap: (id: string) => void;
  setSearch: (s: string) => void;
  setTeamFilter: (t: TeamFilterValue) => void;
  toggleTeamMerged: (teamId: number) => void;
  setMergedTeams: (teamIds: number[]) => void;
  setTheme: (t: Theme) => void;
  setLabelZoom: (l: LabelZoomLevel) => void;
  setTeamGrouping: (on: boolean) => void;
  bumpTick: () => void;
  setRange: (r: TimeRange) => void;
  openTrace: (traceId: string | null) => void;
  setIngesting: (on: boolean) => void;
}

// Persisted preferences seed the initial state; main.tsx syncs the theme to
// <body data-theme> before first paint.
const prefs = loadPrefs();

export const useStore = create<AppState>((set) => ({
  view: 'map',
  graphType: 'map',
  serviceId: null,
  serviceOpFilter: null,
  topology: null,
  selection: null,
  hoverEdge: null,
  focusId: null,
  isolateId: null,
  search: '',
  teamFilter: 'all',
  mergedTeams: [],
  theme: prefs.theme,
  labelZoom: prefs.labelZoom,
  teamGrouping: prefs.teamGrouping,
  tick: 0,
  range: DEFAULT_RANGE,
  openTraceId: null,
  ingesting: false,

  setTopology: (topology) => set({ topology }),
  navigate: (view, serviceId, opFilter) =>
    set({
      view,
      serviceId: serviceId ?? null,
      serviceOpFilter: opFilter ?? null,
      openTraceId: null,
      selection: null,
    }),
  applyRoute: (route) =>
    set({
      view: route.view,
      serviceId: route.serviceId,
      // The op filter is transient and not part of the route, so a deep-link or
      // browser back/forward always lands on an unfiltered service page.
      serviceOpFilter: null,
      graphType: route.graphType,
      openTraceId: route.openTraceId,
      range: route.range,
      teamFilter: route.teamFilter,
      isolateId: route.isolateId,
    }),
  setGraphType: (graphType) => set({ graphType }),
  select: (selection) => set({ selection }),
  setHoverEdge: (hoverEdge) => set({ hoverEdge }),
  setFocus: (focusId) => set({ focusId }),
  setIsolate: (isolateId) => set({ isolateId }),
  isolateOnMap: (isolateId) =>
    set({
      view: 'map',
      graphType: 'map',
      serviceId: null,
      selection: null,
      focusId: null,
      openTraceId: null,
      isolateId,
    }),
  revealOnMap: (id) =>
    set({
      view: 'map',
      graphType: 'map',
      serviceId: null,
      isolateId: null,
      focusId: null,
      openTraceId: null,
      selection: { kind: 'node', id },
    }),
  setSearch: (search) => set({ search }),
  setTeamFilter: (teamFilter) => set({ teamFilter }),
  toggleTeamMerged: (teamId) =>
    set((s) => ({
      mergedTeams: s.mergedTeams.includes(teamId)
        ? s.mergedTeams.filter((t) => t !== teamId)
        : [...s.mergedTeams, teamId],
    })),
  setMergedTeams: (mergedTeams) => set({ mergedTeams }),
  setTheme: (theme) =>
    set((s) => {
      document.body.setAttribute('data-theme', theme);
      savePrefs({ theme, labelZoom: s.labelZoom, teamGrouping: s.teamGrouping });
      return { theme };
    }),
  setLabelZoom: (labelZoom) =>
    set((s) => {
      savePrefs({ theme: s.theme, labelZoom, teamGrouping: s.teamGrouping });
      return { labelZoom };
    }),
  setTeamGrouping: (teamGrouping) =>
    set((s) => {
      savePrefs({ theme: s.theme, labelZoom: s.labelZoom, teamGrouping });
      return { teamGrouping };
    }),
  bumpTick: () => set((s) => ({ tick: s.tick + 1 })),
  setRange: (range) => set({ range }),
  openTrace: (openTraceId) => set({ openTraceId }),
  setIngesting: (ingesting) => set({ ingesting }),
}));
