import type { Graph } from '../../../lib/grouping';
import { matchesTeamFilter, type TeamFilterValue } from '../../../lib/teamFilter';
import type { FocusSet } from './focusSet';

/**
 * Builds the predicate that decides which nodes are dimmed (faded out) on the
 * map: anything outside the active focus cone, not matching the search query,
 * or owned by a non-selected team. Shared by the layered map and the force
 * graph so both views dim consistently from the same selection/search/filter
 * state.
 */
export function buildDimmer(
  graph: Graph,
  opts: { focus: FocusSet | null; query: string; teamFilter: TeamFilterValue },
): (key: string) => boolean {
  const nodeById = new Map(graph.nodes.map((n) => [n.key, n]));
  const q = opts.query.trim().toLowerCase();
  const decide = (key: string): boolean => {
    const n = nodeById.get(key);
    if (!n) return true;
    if (opts.focus && !opts.focus.nodes.has(key)) return true;
    if (q) {
      const hay =
        n.kind === 'group'
          ? [n.label, ...n.memberIds].join(' ').toLowerCase()
          : `${n.key} ${n.label}`.toLowerCase();
      if (!hay.includes(q)) return true;
    }
    // A group node carries its team's id, so the same matcher dims it under a
    // foreign team filter and under "Unassigned" (a team is never unassigned).
    if (!matchesTeamFilter(n.teamId, opts.teamFilter)) return true;
    return false;
  };
  // With nothing to dim by, every known node is lit.
  if (!opts.focus && !q && opts.teamFilter === 'all') return (key) => !nodeById.has(key);
  // Each edge asks about both of its ends on every rebuild, so a node's answer
  // is kept (with a search active it costs a string build and a scan).
  const memo = new Map<string, boolean>();
  return (key: string): boolean => {
    let d = memo.get(key);
    if (d === undefined) {
      d = decide(key);
      memo.set(key, d);
    }
    return d;
  };
}
