import type { MouseEvent } from 'react';
import { GroupExpandIcon } from '../../components/Icon';
import styles from './TeamFrame.module.css';

/**
 * Ownership frame drawn around an unmerged team's nodes, like a box on an
 * infrastructure diagram. It renders in two layers so edges sit between
 * them: the box goes UNDER the edges (and ignores the mouse entirely), while
 * the title bar goes OVER them, so its drag/merge interactions cannot be
 * stolen by an edge's fat invisible hit path crossing the frame.
 */

export function TeamFrameBox({
  x,
  y,
  w,
  h,
  dim,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  dim: boolean;
}) {
  return (
    <div
      className={`${styles.box} ${dim ? styles.dimmed : ''}`}
      style={{ transform: `translate(${x}px, ${y}px)`, width: w, height: h }}
    />
  );
}

export function TeamFrameBar({
  name,
  memberCount,
  x,
  y,
  w,
  dim,
  onMerge,
  onDragStart,
}: {
  name: string;
  memberCount: number;
  x: number;
  y: number;
  w: number;
  dim: boolean;
  onMerge: () => void;
  /** Begin dragging the frame; the caller moves every member node with it. */
  onDragStart: (e: MouseEvent) => void;
}) {
  return (
    <div
      className={`${styles.bar} ${dim ? styles.dimmed : ''} hov-btn`}
      onMouseDown={onDragStart}
      title="Drag to move the whole team"
      style={{ transform: `translate(${x}px, ${y}px)`, width: w }}
    >
      <span className={styles.teamLabel}>TEAM</span>
      <span className={styles.name}>{name}</span>
      <span className={styles.count}>{memberCount}</span>
      <span className={styles.spacer} />
      <span
        className={`${styles.mergeBtn} hov-btn`}
        title="Merge team into one node"
        onClick={(e) => {
          e.stopPropagation();
          onMerge();
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <GroupExpandIcon expanded />
        MERGE
      </span>
    </div>
  );
}
