import type { Team } from '../../../api/types';
import { FRAME_PAD, FRAME_TITLE_H } from '../../../lib/clusterLayout';
import type { GraphNode } from '../../../lib/grouping';
import type { Pos } from '../../../lib/transition';
import { nodeCardBounds } from './nodeBounds';

export interface FrameView {
  teamId: number;
  name: string;
  memberKeys: string[];
  x: number;
  y: number;
  w: number;
  h: number;
  dim: boolean;
}

// Ownership frames around each unmerged team's nodes. Bounds follow the
// members' effective positions, so frames stretch during drags and glide
// along with merge/unmerge animations.
export function buildFrameViews(
  teams: Team[],
  nodes: GraphNode[],
  posOf: (key: string) => Pos | undefined,
  dimmed: (key: string) => boolean,
): FrameView[] {
  return teams.flatMap((t) => {
    const members = nodes.filter((n) => n.kind === 'service' && n.teamId === t.id);
    if (!members.length) return [];
    const b = nodeCardBounds(members.map((m) => posOf(m.key)));
    if (!b) return [];
    return [
      {
        teamId: t.id,
        name: t.name,
        memberKeys: members.map((m) => m.key),
        x: b.x0 - FRAME_PAD,
        y: b.y0 - FRAME_TITLE_H,
        w: b.x1 - b.x0 + 2 * FRAME_PAD,
        h: b.y1 - b.y0 + FRAME_TITLE_H + FRAME_PAD,
        dim: members.every((m) => dimmed(m.key)),
      },
    ];
  });
}
