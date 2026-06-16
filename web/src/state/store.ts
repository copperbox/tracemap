import { create } from 'zustand';
import type { Topology } from '../api/types';
import type { TeamFilterValue } from '../lib/teamFilter';
import { DEFAULT_RANGE, type TimeRange } from '../lib/timerange';
import type { RouteState } from './routing';

export type View = 'map' | 'services' | 'service';
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
  theme: 'dark' | 'light';
  tick: number;
  range: TimeRange;
  openTraceId: string | null;
  ingesting: boolean;

  setTopology: (t: Topology) => void;
  navigate: (view: View, serviceId?: string) => void;
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
  setTheme: (t: 'dark' | 'light') => void;
  bumpTick: () => void;
  setRange: (r: TimeRange) => void;
  openTrace: (traceId: string | null) => void;
  setIngesting: (on: boolean) => void;
}

export const useStore = create<AppState>((set) => ({
  view: 'map',
  graphType: 'map',
  serviceId: null,
  topology: null,
  selection: null,
  hoverEdge: null,
  focusId: null,
  isolateId: null,
  search: '',
  teamFilter: 'all',
  mergedTeams: [],
  theme: 'dark',
  tick: 0,
  range: DEFAULT_RANGE,
  openTraceId: null,
  ingesting: false,

  setTopology: (topology) => set({ topology }),
  navigate: (view, serviceId) =>
    set({ view, serviceId: serviceId ?? null, openTraceId: null, selection: null }),
  applyRoute: (route) =>
    set({
      view: route.view,
      serviceId: route.serviceId,
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
  setTheme: (theme) => {
    document.body.setAttribute('data-theme', theme);
    set({ theme });
  },
  bumpTick: () => set((s) => ({ tick: s.tick + 1 })),
  setRange: (range) => set({ range }),
  openTrace: (openTraceId) => set({ openTraceId }),
  setIngesting: (ingesting) => set({ ingesting }),
}));
