import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { TYPE_LABELS } from '../../components/Icon';
import { MiniSpark } from '../../components/MiniSpark';
import { TeamFilter } from '../../components/TeamFilter';
import {
  useElementWidth,
  useListKeyboard,
  useWindowedFocus,
  useWindowedRows,
} from '../../components/useWindowedRows';
import { gridColumns } from '../../components/windowing';
import { DOT, fmtErr, fmtMs, fmtRps } from '../../lib/format';
import { stBg, stColor, stLabel } from '../../lib/status';
import { rankServiceRows, type ServiceExtra, type ServiceRow } from '../../state/serviceRows';
import { useStore } from '../../state/store';
import { useServiceExtras } from '../../state/useServiceList';
import { WallboardDrawer } from './WallboardDrawer';
import { toggleCardSelection } from './wallboardSelection';
import styles from './WallboardPage.module.css';

// Keep in sync with `.grid` and `.card` in the CSS: windowing needs fixed sizes.
const CARD_MIN_W = 230;
const CARD_H = 150;
const GAP = 14;
const ROW_H = CARD_H + GAP;

/**
 * Wallboard: one card per service, readable from across the room. Same data,
 * filters, and health-first ranking as the services list -- only the rendering
 * differs: a responsive card grid where warn/crit tint the whole card surface
 * instead of a table row dot. Only the card rows near the viewport mount.
 */
export function WallboardPage() {
  const selection = useStore((s) => s.selection);
  const search = useStore((s) => s.search);
  const topology = useStore((s) => s.topology);
  const teamFilter = useStore((s) => s.teamFilter);
  const setTeamFilter = useStore((s) => s.setTeamFilter);
  const extras = useServiceExtras();

  const teams = topology?.teams;
  const services = topology?.services;
  const teamName = useMemo(() => new Map((teams ?? []).map((t) => [t.id, t.name])), [teams]);
  const cards = useMemo(() => rankServiceRows(services ?? [], search, teamFilter), [services, search, teamFilter]);
  const total = services?.length ?? 0;
  const countLabel = cards.length === total ? `${total} services` : `${cards.length} of ${total} services`;
  const selectedId = selection?.kind === 'node' ? selection.id : null;

  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const cols = gridColumns(useElementWidth(listRef), CARD_MIN_W, GAP);
  const win = useWindowedRows(scrollRef, listRef, ROW_H, Math.ceil(cards.length / cols), 2);
  const { focusRow, afterRender } = useWindowedFocus(scrollRef, listRef, ROW_H);
  useLayoutEffect(afterRender);

  // Reads the selection at click time so the callback stays stable for memo.
  const toggle = useCallback((id: string) => {
    const s = useStore.getState();
    s.select(toggleCardSelection(s.selection, id));
  }, []);
  const kb = useListKeyboard({ count: cards.length, cols, focusRow, onActivate: (i) => toggle(cards[i].id) });
  const first = win.start * cols;
  const last = Math.min(cards.length, win.end * cols);
  const tabIndex = kb.activeIndex >= first && kb.activeIndex < last ? kb.activeIndex : first;

  return (
    <>
      <div className={styles.page} ref={scrollRef}>
        <div className={styles.content}>
          <div className={styles.heading}>
            <div className={styles.headingText}>
              <div className={styles.title}>Wallboard</div>
              <div className={styles.subtitle}>{`${countLabel} ${DOT} one card per service ${DOT} sorted by health`}</div>
            </div>
            <TeamFilter teams={teams ?? []} value={teamFilter} onChange={setTeamFilter} />
          </div>
          <div
            ref={listRef}
            className={styles.body}
            role="list"
            aria-label="Services"
            style={{ height: Math.max(0, win.totalHeight - GAP) }}
            onKeyDown={kb.onKeyDown}
            onFocus={kb.onFocus}
          >
            <div className={styles.grid} style={{ transform: `translateY(${win.offset}px)` }}>
              {cards.slice(first, last).map((r, k) => (
                <ServiceCard
                  key={r.id}
                  row={r}
                  index={first + k}
                  setSize={cards.length}
                  tabbable={first + k === tabIndex}
                  extra={extras?.get(r.id)}
                  team={r.teamId != null ? (teamName.get(r.teamId) ?? '--') : '--'}
                  selected={r.id === selectedId}
                  onToggle={toggle}
                />
              ))}
            </div>
          </div>
          {!cards.length && (
            <div className={styles.empty}>{topology ? 'no services match' : 'waiting for telemetry…'}</div>
          )}
        </div>
      </div>
      <WallboardDrawer />
    </>
  );
}

const ServiceCard = memo(function ServiceCard({
  row,
  index,
  setSize,
  tabbable,
  extra,
  team,
  selected,
  onToggle,
}: {
  row: ServiceRow;
  index: number;
  setSize: number;
  tabbable: boolean;
  extra: ServiceExtra | undefined;
  team: string;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const s = row.svc;
  const c = stColor(s.status);
  const unhealthy = s.status !== 'ok';
  return (
    <div role="listitem" aria-posinset={index + 1} aria-setsize={setSize} className={styles.item}>
      <div
        className={`${styles.card} ${selected ? styles.selected : ''} hov-row`}
        role="button"
        aria-pressed={selected}
        data-row-index={index}
        tabIndex={tabbable ? 0 : -1}
        // stColor/stBg resolve status -> theme vars, so the tint stays inline
        style={unhealthy ? { borderColor: c, background: stBg(s.status) } : undefined}
        onClick={() => onToggle(s.id)}
      >
        <div className={styles.cardTop}>
          <span className={styles.name}>{s.name}</span>
          <span className={styles.pill} style={{ color: c, background: stBg(s.status) }}>
            {stLabel(s.status)}
          </span>
        </div>
        <div className={styles.meta}>{`${team} ${DOT} ${TYPE_LABELS[s.type] ?? s.type.toUpperCase()}`}</div>
        <div className={styles.metrics}>
          <div className={styles.metricCell}>
            <span className={styles.metricLabel}>ERR</span>
            <span className={styles.err} style={{ color: unhealthy ? c : 'var(--text)' }}>
              {fmtErr(s.metrics.errPct)}
            </span>
          </div>
          <div className={styles.metricCell}>
            <span className={styles.metricLabel}>P95</span>
            <span className={styles.metricValue}>{fmtMs(s.metrics.p95)}</span>
          </div>
          <div className={styles.metricCell}>
            <span className={styles.metricLabel}>REQ/S</span>
            <span className={styles.metricValue}>{fmtRps(s.metrics.rps)}</span>
          </div>
        </div>
        <MiniSpark data={extra?.spark} color={unhealthy ? c : 'var(--faint)'} className={styles.spark} />
      </div>
    </div>
  );
});
