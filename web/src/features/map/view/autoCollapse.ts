import { useEffect, useMemo, useRef } from 'react';
import type { Topology } from '../../../api/types';
import type { Selection } from '../../../state/store';
import type { TeamFilterValue } from '../../../lib/teamFilter';

/**
 * Large-fleet default: start the map with every team collapsed into its
 * meganode, so the first view is a few hundred team nodes instead of
 * thousands of services. Decided once per page load, on the first topology;
 * after that the user's merge/unmerge choices stand.
 */

/** Fleet size from which teams start collapsed. */
export const LARGE_FLEET_SERVICES = 300;

// `?teams=expanded` opts out. Read at module load, before initRouting
// normalizes the query string.
const FORCE_EXPANDED =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('teams') === 'expanded';

/** Team ids a selection or isolate key points into (services and edges). */
export function teamsReferenced(topo: Topology, keys: (string | null | undefined)[]): Set<number> {
  const teamOf = new Map(topo.services.map((s) => [s.id, s.teamId]));
  const out = new Set<number>();
  for (const key of keys) {
    if (!key) continue;
    for (const part of key.split('=>')) {
      const t = teamOf.get(part);
      if (t != null) out.add(t);
    }
  }
  return out;
}

/**
 * The teams to collapse on first load, or null to leave the merge state alone:
 * a small fleet, an explicit `?teams=expanded`, or a merge state the user has
 * already set. Teams the deep link points into stay expanded.
 */
export function planAutoCollapse(opts: {
  topology: Topology;
  mergedTeams: number[];
  keep: Set<number>;
  forceExpanded?: boolean;
}): number[] | null {
  const { topology, mergedTeams, keep } = opts;
  if (opts.forceExpanded) return null;
  if (mergedTeams.length) return null;
  if (topology.services.length < LARGE_FLEET_SERVICES) return null;
  const ids = topology.teams.map((t) => t.id).filter((id) => !keep.has(id));
  return ids.length ? ids : null;
}

/**
 * Merge state with the teams of revealed services expanded: a selected node or
 * isolated tree inside a merged team would otherwise point at a service the
 * map does not draw. Returns `merged` itself when nothing needs expanding.
 */
export function revealTeams(merged: number[], reveal: Set<number>): number[] {
  if (!reveal.size || !merged.some((t) => reveal.has(t))) return merged;
  return merged.filter((t) => !reveal.has(t));
}

let decided = false;
const NO_TEAMS = new Set<number>();

/** Test hook: forget the once-per-load decision. */
export function resetAutoCollapseForTest(): void {
  decided = false;
}

/**
 * The merge state the map should render now. Applies the first-load collapse
 * and the reveal expansion in the same render (so the map never lays out the
 * full fleet first, and the drawer never sees its selection vanish), then
 * writes the result back to the store.
 */
export function useEffectiveMergedTeams(opts: {
  topology: Topology | null;
  mergedTeams: number[];
  setMergedTeams: (ids: number[]) => void;
  selection: Selection;
  isolateId: string | null;
  teamFilter: TeamFilterValue;
}): number[] {
  const { topology, mergedTeams, setMergedTeams, selection, isolateId, teamFilter } = opts;
  const selKey = selection?.kind === 'node' ? selection.id : selection?.kind === 'edge' ? selection.id : null;

  const reveal = useMemo(
    () => (topology ? teamsReferenced(topology, [selKey, isolateId]) : new Set<number>()),
    // keyed on the keys, not the topology: a fresh metrics frame must not
    // count as a new reveal
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selKey, isolateId, topology != null],
  );

  // A reveal applies once, when the selection or isolate key changes. After
  // that the user may merge the selected node's team and the map must let them.
  const consumedRef = useRef<Set<number> | null>(null);
  const pending = consumedRef.current === reveal ? NO_TEAMS : reveal;

  const effective = useMemo(() => {
    let base = mergedTeams;
    if (!decided && topology) {
      const keep = new Set(reveal);
      if (typeof teamFilter === 'number') keep.add(teamFilter);
      base = planAutoCollapse({ topology, mergedTeams, keep, forceExpanded: FORCE_EXPANDED }) ?? mergedTeams;
    }
    return revealTeams(base, pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- topology presence only
  }, [mergedTeams, pending, teamFilter, topology != null]);

  useEffect(() => {
    if (!topology) return;
    decided = true;
    consumedRef.current = reveal;
    if (effective !== mergedTeams) setMergedTeams(effective);
  }, [effective, mergedTeams, setMergedTeams, topology, reveal]);

  return effective;
}
