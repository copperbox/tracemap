import type { MouseEvent } from 'react';
import { GroupExpandIcon } from '../../components/Icon';

const mono = (px: number, weight = 500): string => `${weight} ${px}px 'JetBrains Mono', monospace`;

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
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        transform: `translate(${x}px, ${y}px)`,
        width: w,
        height: h,
        border: '1.6px solid var(--frame-line)',
        borderRadius: 14,
        background: 'var(--frame-bg)',
        opacity: dim ? 0.13 : 1,
        transition: 'opacity .25s',
        pointerEvents: 'none',
      }}
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
      className="hov-btn"
      onMouseDown={onDragStart}
      title="Drag to move the whole team"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        transform: `translate(${x}px, ${y}px)`,
        width: w,
        height: 30,
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '0 6px 0 10px',
        boxSizing: 'border-box',
        borderRadius: '14px 14px 0 0',
        cursor: 'grab',
        opacity: dim ? 0.13 : 1,
        transition: 'opacity .25s',
      }}
    >
      <span style={{ font: mono(9, 600), letterSpacing: '.13em', color: 'var(--faint)' }}>TEAM</span>
      <span style={{ font: "700 22px 'Space Grotesk'", color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {name}
      </span>
      <span style={{ font: mono(9.5), color: 'var(--dim)' }}>{memberCount}</span>
      <span style={{ flex: 1 }} />
      <span
        className="hov-btn"
        title="Merge team into one node"
        onClick={(e) => {
          e.stopPropagation();
          onMerge();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '3px 8px',
          borderRadius: 6,
          border: '1px solid var(--line2)',
          background: 'var(--bg2)',
          color: 'var(--dim)',
          font: mono(8.5, 600),
          letterSpacing: '.08em',
          cursor: 'pointer',
          flex: 'none',
        }}
      >
        <GroupExpandIcon expanded />
        MERGE
      </span>
    </div>
  );
}
