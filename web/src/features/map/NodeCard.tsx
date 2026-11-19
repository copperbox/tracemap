import { memo, useMemo } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import type { GraphNode } from '../../lib/grouping';
import { GROUP_W, NODE_W } from '../../lib/layout';
import { fmtErr, fmtMs, fmtRps, DOT } from '../../lib/format';
import { GroupExpandIcon, TypeIcon, TYPE_LABELS } from '../../components/Icon';
import styles from './NodeCard.module.css';

/** Length of one critical-ring pulse (keep in step with critRing in NodeCard.module.css). */
const CRIT_PULSE_MS = 2400;

/**
 * Card callbacks. The map passes one stable object for every card, so a
 * card's props only change when its node, position or highlight does and
 * React.memo can skip the rest of the fleet.
 */
export interface CardHandlers {
  click: (e: MouseEvent, node: GraphNode) => void;
  open: (node: GraphNode) => void;
  toggleGroup: (node: GraphNode) => void;
  dragStart: (e: MouseEvent, node: GraphNode) => void;
  /** Enter or Space on a focused card. */
  activate: (node: GraphNode) => void;
}

export const NOOP_CARD_HANDLERS: CardHandlers = {
  click: () => {},
  open: () => {},
  toggleGroup: () => {},
  dragStart: () => {},
  activate: () => {},
};

const STATUS_WORD = { ok: 'healthy', warn: 'degraded', crit: 'critical' } as const;

export const NodeCard = memo(function NodeCard({
  node,
  x,
  y,
  dim,
  selected,
  teamLabel,
  compact,
  fade,
  ghost,
  handlers,
}: {
  node: GraphNode;
  x: number;
  y: number;
  dim: boolean;
  selected: boolean;
  /** Owning team shown as a subtitle under the name (team grouping off only). */
  teamLabel?: string | null;
  /** Zoomed too far out to read text: hide the labels (keeping the card's
   *  footprint) so the map reads as clean status nodes rather than a blur. */
  compact?: boolean;
  /** Opacity multiplier driven per-frame by graph transitions (disables the CSS opacity transition). */
  fade?: number;
  /** Non-interactive leftover of a removed node, shown only while a transition runs. */
  ghost?: boolean;
  handlers: CardHandlers;
}) {
  const isGroup = node.kind === 'group';
  const dashed =
    node.isExternal || (node.type !== 'service' && node.type !== 'bff' && node.type !== 'gateway' && !isGroup);

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
  // Critical rings pulse in steps. Starting each one as if at a multiple of the
  // cycle puts every ring's steps on the same instants, so the compositor
  // wakes seven times a second for all of them, not for each.
  const pulsing = node.status === 'crit' && !selected;
  const critPhase = useMemo(() => (pulsing ? `${-(performance.now() % CRIT_PULSE_MS)}ms` : null), [pulsing]);
  const cardStyle: CSSProperties | undefined = selected
    ? ({ '--sel': selColor, '--sel-soft': selSoft } as CSSProperties)
    : critPhase
      ? ({ '--crit-phase': critPhase } as CSSProperties)
      : undefined;

  // Kept lean on purpose: the map mounts a few hundred of these, so every
  // element here is multiplied (metrics are one text run, not five spans).
  return (
    <div
      data-node-key={ghost ? undefined : node.key}
      role={ghost ? undefined : 'button'}
      tabIndex={ghost ? -1 : 0}
      aria-hidden={ghost || undefined}
      aria-pressed={ghost ? undefined : selected}
      aria-label={
        ghost
          ? undefined
          : `${isGroup ? `Team ${node.label}, ${node.memberIds.length} services` : node.label}, ${STATUS_WORD[node.status]}`
      }
      onKeyDown={(e: KeyboardEvent) => {
        if (ghost || e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        handlers.activate(node);
      }}
      onClick={(e) => handlers.click(e, node)}
      onDoubleClick={() => handlers.open(node)}
      onMouseDown={(e) => handlers.dragStart(e, node)}
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
          {isGroup && (
            <span
              className={`${styles.toggleBtn} hov-btn`}
              title="Unmerge team"
              onClick={(e) => {
                e.stopPropagation();
                handlers.toggleGroup(node);
              }}
            >
              <GroupExpandIcon expanded={false} />
            </span>
          )}
          <span className={`${styles.statusDot} ${dotCls}`} />
        </div>
        <div className={`${styles.name} ${isGroup ? styles.nameGroup : ''}`}>{node.label}</div>
        {teamLabel && <div className={styles.team}>{teamLabel}</div>}
        <div className={styles.metrics}>
          {`${fmtRps(node.rps)}/s  ${DOT}  ${fmtMs(node.p95)}  ${DOT}  `}
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
});
