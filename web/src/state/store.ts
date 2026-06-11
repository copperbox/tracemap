import { create } from 'zustand';
import type { Topology } from '../api/types';
import { DEFAULT_RANGE, type TimeRange } from '../lib/timerange';

export type View = 'map' | 'services' | 'service';
export type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string } // "source->target"
  | { kind: 'group'; teamId: number }
  | null;

interface AppState {
  view: View;
  serviceId: string | null;
  topology: Topology | null;
  selection: Selection;
  hoverEdge: string | null;
  focusId: string | null; // node id or "group:<teamId>"
  search: string;
  teamFilter: number | 'all';
  groupByTeam: boolean;
  expandedTeams: number[];
  theme: 'dark' | 'light';
  tick: number;
  range: TimeRange;
  openTraceId: string | null;
  ingesting: boolean;

  setTopology: (t: Topology) => void;
  navigate: (view: View, serviceId?: string) => void;
  select: (sel: Selection) => void;
  setHoverEdge: (id: string | null) => void;
  setFocus: (id: string | null) => void;
  setSearch: (s: string) => void;
  setTeamFilter: (t: number | 'all') => void;
  setGroupByTeam: (on: boolean) => void;
  toggleTeamExpanded: (teamId: number) => void;
  collapseAllTeams: () => void;
  setTheme: (t: 'dark' | 'light') => void;
  bumpTick: () => void;
  setRange: (r: TimeRange) => void;
  openTrace: (traceId: string | null) => void;
  setIngesting: (on: boolean) => void;
}

export const useStore = create<AppState>((set) => ({
  view: 'map',
  serviceId: null,
  topology: null,
  selection: null,
  hoverEdge: null,
  focusId: null,
  search: '',
  teamFilter: 'all',
  groupByTeam: false,
  expandedTeams: [],
  theme: 'dark',
  tick: 0,
  range: DEFAULT_RANGE,
  openTraceId: null,
  ingesting: false,

  setTopology: (topology) => set({ topology }),
  navigate: (view, serviceId) =>
    set({ view, serviceId: serviceId ?? null, openTraceId: null, selection: null }),
  select: (selection) => set({ selection }),
  setHoverEdge: (hoverEdge) => set({ hoverEdge }),
  setFocus: (focusId) => set({ focusId }),
  setSearch: (search) => set({ search }),
  setTeamFilter: (teamFilter) => set({ teamFilter }),
  setGroupByTeam: (groupByTeam) => set({ groupByTeam, expandedTeams: [] }),
  toggleTeamExpanded: (teamId) =>
    set((s) => ({
      expandedTeams: s.expandedTeams.includes(teamId)
        ? s.expandedTeams.filter((t) => t !== teamId)
        : [...s.expandedTeams, teamId],
    })),
  collapseAllTeams: () => set({ expandedTeams: [] }),
  setTheme: (theme) => {
    document.body.setAttribute('data-theme', theme);
    set({ theme });
  },
  bumpTick: () => set((s) => ({ tick: s.tick + 1 })),
  setRange: (range) => set({ range }),
  openTrace: (openTraceId) => set({ openTraceId }),
  setIngesting: (ingesting) => set({ ingesting }),
}));
