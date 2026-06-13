import type { MouseEvent } from 'react';
import type { GraphNode } from '../../lib/grouping';
import { GROUP_W, NODE_W } from '../../lib/layout';
import { fmtErr, fmtMs, fmtRps, jit, DOT } from '../../lib/format';
import { stColor } from '../../lib/status';
import { GroupExpandIcon, TypeIcon, TYPE_LABELS } from '../../components/Icon';

const mono = (px: number, weight = 500): string => `${weight} ${px}px 'JetBrains Mono', monospace`;

export function NodeCard({
  node,
  x,
  y,
  tick,
  dim,
  selected,
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
  const c = stColor(node.status);
  const border = selected
    ? 'var(--accent)'
    : node.status === 'crit'
      ? 'rgba(248,113,113,.65)'
      : node.status === 'warn'
        ? 'rgba(251,191,36,.5)'
        : 'var(--line2)';

  const showToggle = isGroup && onToggleGroup;

  return (
    <div
      onClick={onClick}
      onDoubleClick={onOpen}
      onMouseDown={onDragStart}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: isGroup ? GROUP_W : NODE_W,
        cursor: 'pointer',
        transform: `translate(${x}px, ${y}px)`,
        opacity: (dim ? 0.13 : 1) * (fade ?? 1),
        transition: fade == null ? 'opacity .25s' : 'none',
        pointerEvents: ghost ? 'none' : undefined,
      }}
    >
      <div
        style={{
          background: 'var(--panel)',
          border: `${isGroup ? '1.4px' : '1.2px'} ${node.isExternal || (node.type !== 'service' && node.type !== 'bff' && node.type !== 'gateway' && !isGroup) ? 'dashed' : 'solid'} ${border}`,
          borderRadius: 11,
          padding: isGroup ? '10px 13px 11px' : '9px 12px 10px',
          boxShadow: selected
            ? '0 0 0 3px var(--accent-dim), 0 14px 36px rgba(0,0,0,.35)'
            : isGroup
              ? '0 10px 30px rgba(0,0,0,.28)'
              : '0 6px 22px rgba(0,0,0,.2)',
          animation: node.status === 'crit' && !selected ? 'critPulse 2.4s ease-in-out infinite' : 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <TypeIcon type={node.type} />
          <span style={{ font: mono(8.5, 600), letterSpacing: '.13em', color: 'var(--faint)' }}>
            {isGroup ? `TEAM ${DOT} ${node.memberIds.length} SERVICES` : (TYPE_LABELS[node.type] ?? node.type.toUpperCase())}
          </span>
          <span style={{ flex: 1 }} />
          {showToggle && (
            <span
              className="hov-btn"
              title="Unmerge team"
              onClick={(e) => {
                e.stopPropagation();
                onToggleGroup?.();
              }}
              style={{
                width: 18,
                height: 18,
                borderRadius: 5,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--faint)',
                flex: 'none',
              }}
            >
              <GroupExpandIcon expanded={false} />
            </span>
          )}
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: c,
              boxShadow: `0 0 8px ${c}`,
              flex: 'none',
            }}
          />
        </div>
        <div
          style={{
            font: `600 ${isGroup ? '14.5px' : '13.5px'} 'Space Grotesk'`,
            margin: '5px 0 4px',
            letterSpacing: '.01em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {node.label}
        </div>
        <div style={{ display: 'flex', gap: 7, font: mono(9.5), color: 'var(--dim)', whiteSpace: 'nowrap' }}>
          <span>{fmtRps(node.rps * jit(node.key, tick))}/s</span>
          <span style={{ color: 'var(--faint)' }}>{DOT}</span>
          <span>{fmtMs(node.p95 == null ? null : node.p95 * jit(node.key + 'l', tick, 0.06))}</span>
          <span style={{ color: 'var(--faint)' }}>{DOT}</span>
          <span style={{ color: node.status === 'ok' ? 'var(--dim)' : c }}>{fmtErr(node.errPct)}</span>
        </div>
        {isGroup && (
          <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {node.memberIds.slice(0, 4).map((m) => (
              <span
                key={m}
                style={{
                  font: mono(8.5),
                  color: 'var(--faint)',
                  background: 'var(--panel2)',
                  border: '1px solid var(--line)',
                  borderRadius: 5,
                  padding: '1px 6px',
                  maxWidth: 86,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {m}
              </span>
            ))}
            {node.memberIds.length > 4 && (
              <span style={{ font: mono(8.5), color: 'var(--faint)', padding: '1px 2px' }}>
                +{node.memberIds.length - 4}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
