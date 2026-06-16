import type { CSSProperties, MouseEvent } from 'react';
import type { GraphNode } from '../../lib/grouping';
import { GROUP_W, NODE_W } from '../../lib/layout';
import { fmtErr, fmtMs, fmtRps, jit, DOT } from '../../lib/format';
import { GroupExpandIcon, TypeIcon, TYPE_LABELS } from '../../components/Icon';
import styles from './NodeCard.module.css';

export function NodeCard({
  node,
  x,
  y,
  tick,
  dim,
  selected,
  compact,
  fade,
  ghost,
  onClick,
  onOpen,
  onToggleGroup,
  onDragStart,
}: {
  node: GraphNode;
  x: number;
  y: number;
  tick: number;
  dim: boolean;
  selected: boolean;
  /** Zoomed too far out to read text: hide the labels (keeping the card's
   *  footprint) so the map reads as clean status nodes rather than a blur. */
  compact?: boolean;
  /** Opacity multiplier driven per-frame by graph transitions (disables the CSS opacity transition). */
  fade?: number;
  /** Non-interactive leftover of a removed node, shown only while a transition runs. */
  ghost?: boolean;
  onClick: (e: MouseEvent) => void;
  onOpen: () => void;
  onToggleGroup?: () => void;
  /** Begin dragging this node to a pinned position. */
  onDragStart?: (e: MouseEvent) => void;
}) {
  const isGroup = node.kind === 'group';
  const dashed =
    node.isExternal || (node.type !== 'service' && node.type !== 'bff' && node.type !== 'gateway' && !isGroup);

  const showToggle = isGroup && onToggleGroup;

  const cardCls = [
    styles.card,
    compact ? styles.compact : '',
    isGroup ? styles.group : '',
    dashed ? styles.dashed : '',
    !selected && node.status === 'warn' ? styles.warn : '',
    !selected && node.status === 'crit' ? styles.crit : '',
    selected ? styles.selected : '',
  ]
    .filter(Boolean)
    .join(' ');

  const dotCls = node.status === 'crit' ? styles.dotCrit : node.status === 'warn' ? styles.dotWarn : styles.dotOk;

  // Selection border + glow take the node's status hue (green when healthy) so a
  // degraded/critical node keeps signaling its state while selected.
  const selColor = node.status === 'crit' ? 'var(--crit)' : node.status === 'warn' ? 'var(--warn)' : 'var(--accent)';
  const selSoft =
    node.status === 'crit' ? 'var(--critbg)' : node.status === 'warn' ? 'var(--warnbg)' : 'var(--accent-dim)';
  const cardStyle: CSSProperties = {
    /* critPulse lives in the global stylesheet; referencing it from the CSS
       module would let the module's name scoping rename it away */
    animation: node.status === 'crit' && !selected ? 'critPulse 2.4s ease-in-out infinite' : 'none',
    ...(selected ? ({ '--sel': selColor, '--sel-soft': selSoft } as CSSProperties) : null),
  };

  return (
    <div
      onClick={onClick}
      onDoubleClick={onOpen}
      onMouseDown={onDragStart}
      className={`${styles.root} ${fade != null ? styles.noTransition : ''} ${ghost ? styles.ghost : ''}`}
      style={{
        width: isGroup ? GROUP_W : NODE_W,
        transform: `translate(${x}px, ${y}px)`,
        opacity: (dim ? 0.13 : 1) * (fade ?? 1),
      }}
    >
      <div className={cardCls} style={cardStyle}>
        <div className={styles.head}>
          <TypeIcon type={node.type} />
          <span className={styles.typeLabel}>
            {isGroup ? `TEAM ${DOT} ${node.memberIds.length} SERVICES` : (TYPE_LABELS[node.type] ?? node.type.toUpperCase())}
          </span>
          <span className={styles.spacer} />
          {showToggle && (
            <span
              className={`${styles.toggleBtn} hov-btn`}
              title="Unmerge team"
              onClick={(e) => {
                e.stopPropagation();
                onToggleGroup?.();
              }}
            >
              <GroupExpandIcon expanded={false} />
            </span>
          )}
          <span className={`${styles.statusDot} ${dotCls}`} />
        </div>
        <div className={`${styles.name} ${isGroup ? styles.nameGroup : ''}`}>{node.label}</div>
        <div className={styles.metrics}>
          <span>{fmtRps(node.rps * jit(node.key, tick))}/s</span>
          <span className={styles.sep}>{DOT}</span>
          <span>{fmtMs(node.p95 == null ? null : node.p95 * jit(node.key + 'l', tick, 0.06))}</span>
          <span className={styles.sep}>{DOT}</span>
          <span className={node.status === 'ok' ? '' : node.status === 'crit' ? styles.errCrit : styles.errWarn}>
            {fmtErr(node.errPct)}
          </span>
        </div>
        {isGroup && (
          <div className={styles.members}>
            {node.memberIds.slice(0, 4).map((m) => (
              <span key={m} className={styles.memberChip}>
                {m}
              </span>
            ))}
            {node.memberIds.length > 4 && <span className={styles.moreChip}>+{node.memberIds.length - 4}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
