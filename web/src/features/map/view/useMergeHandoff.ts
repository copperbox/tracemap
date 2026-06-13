import { useCallback, useLayoutEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { groupKey, type Graph } from '../../../lib/grouping';
import { GROUP_H, GROUP_W } from '../../../lib/layout';
import type { Pos } from '../../../lib/transition';
import { nodeCardBounds } from './nodeBounds';
import { savePinnedPositions, type NodePositions } from './pinnedPositions';

/**
 * ---- in-place merge/unmerge for dragged teams ----
 * The cluster layout already keeps an untouched team in the same slot when
 * it merges/unmerges. But once a team has been dragged (pinned), the layout
 * slot no longer matches where it sits, so hand the position across the
 * toggle: merging pins the meganode at the frame's center (consuming the
 * member pins), and unmerging re-pins the members around the meganode.
 */
export function useMergeHandoff(opts: {
  graph: Graph;
  layout: { pos: Map<string, Pos> };
  pinned: NodePositions;
  mergedTeams: number[];
  posOf: (key: string) => Pos | undefined;
  setPinned: Dispatch<SetStateAction<NodePositions>>;
  toggleTeamMerged: (teamId: number) => void;
}): (teamId: number) => void {
  const { graph, layout, pinned, mergedTeams, posOf, setPinned, toggleTeamMerged } = opts;

  const persistPins = (next: NodePositions): NodePositions => {
    savePinnedPositions(next);
    return next;
  };

  const pendingUnmergeRef = useRef<{ teamId: number; cx: number; cy: number } | null>(null);

  const toggleMerge = useCallback(
    (teamId: number) => {
      if (!mergedTeams.includes(teamId)) {
        const members = graph.nodes.filter((n) => n.kind === 'service' && n.teamId === teamId);
        if (members.some((m) => pinned[m.key])) {
          const b = nodeCardBounds(members.map((m) => posOf(m.key)));
          if (b) {
            setPinned((prev) => {
              const next = { ...prev };
              for (const m of members) delete next[m.key];
              next[groupKey(teamId)] = {
                x: (b.x0 + b.x1) / 2 - GROUP_W / 2,
                y: (b.y0 + b.y1) / 2 - GROUP_H / 2,
              };
              return persistPins(next);
            });
          }
        }
      } else {
        const gk = groupKey(teamId);
        const gp = pinned[gk];
        if (gp) {
          pendingUnmergeRef.current = { teamId, cx: gp.x + GROUP_W / 2, cy: gp.y + GROUP_H / 2 };
          setPinned((prev) => {
            const next = { ...prev };
            delete next[gk];
            return persistPins(next);
          });
        }
      }
      toggleTeamMerged(teamId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- persistPins is a stable local helper
    [mergedTeams, graph, pinned, posOf, setPinned, toggleTeamMerged],
  );

  // After an unmerge of a dragged team, the new layout is known: shift the
  // members' layout positions so their frame is centered where the meganode
  // sat, and pin them there.
  useLayoutEffect(() => {
    const pend = pendingUnmergeRef.current;
    if (!pend) return;
    const members = graph.nodes.filter((n) => n.kind === 'service' && n.teamId === pend.teamId);
    const pts = members.map((m) => layout.pos.get(m.key));
    if (!members.length || pts.some((p) => !p)) return; // layout not updated yet
    pendingUnmergeRef.current = null;
    const b = nodeCardBounds(pts);
    if (!b) return;
    const dx = pend.cx - (b.x0 + b.x1) / 2;
    const dy = pend.cy - (b.y0 + b.y1) / 2;
    setPinned((prev) => {
      const next = { ...prev };
      members.forEach((m, i) => {
        const p = pts[i] as Pos;
        next[m.key] = { x: p.x + dx, y: p.y + dy };
      });
      return persistPins(next);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per layout change, as before extraction
  }, [graph, layout]);

  return toggleMerge;
}
