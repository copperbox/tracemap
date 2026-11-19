import { memo } from 'react';
import type { MouseEvent } from 'react';
import { GroupExpandIcon } from '../../components/Icon';
import styles from './TeamFrame.module.css';

/**
 * Title bar of the ownership frame drawn around an unmerged team's nodes, like
 * a box on an infrastructure diagram. The frame box itself is drawn on the map
 * canvas under the edges; the bar is DOM above them so its drag and merge
 * interactions cannot be stolen by an edge crossing the frame.
 */

/** Frame bar callbacks, one stable object for every bar (keeps memo effective). */
export interface FrameHandlers {
  merge: (teamId: number) => void;
  /** Begin dragging the frame; the map moves every member node with it. */
  dragStart: (e: MouseEvent, teamId: number) => void;
}

export const TeamFrameBar = memo(function TeamFrameBar({
  teamId,
  name,
  memberCount,
  x,
  y,
  w,
  dim,
  handlers,
}: {
  teamId: number;
  name: string;
  memberCount: number;
  x: number;
  y: number;
  w: number;
  dim: boolean;
  handlers: FrameHandlers;
}) {
  return (
    <div
      className={`${styles.bar} ${dim ? styles.dimmed : ''} hov-btn`}
      onMouseDown={(e) => handlers.dragStart(e, teamId)}
      title="Drag to move the whole team"
      style={{ transform: `translate(${x}px, ${y}px)`, width: w }}
    >
      <span className={styles.teamLabel}>TEAM</span>
      <span className={styles.name}>{name}</span>
      <span className={styles.count}>{memberCount}</span>
      <span
        className={`${styles.mergeBtn} hov-btn`}
        title="Merge team into one node"
        onClick={(e) => {
          e.stopPropagation();
          handlers.merge(teamId);
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <GroupExpandIcon expanded />
        MERGE
      </span>
    </div>
  );
});
