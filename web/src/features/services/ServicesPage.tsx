import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { TeamFilter } from '../../components/TeamFilter';
import { TYPE_LABELS } from '../../components/Icon';
import { MiniSpark } from '../../components/MiniSpark';
import { useListKeyboard, useWindowedFocus, useWindowedRows } from '../../components/useWindowedRows';
import { DOT, fmtErr, fmtMs, fmtRps } from '../../lib/format';
import { sloView, stColor, stLabel } from '../../lib/status';
import { rankServiceRows, type ServiceExtra, type ServiceRow } from '../../state/serviceRows';
import { useListHold, useStableRank } from '../../state/stableRank';
import { useStore } from '../../state/store';
import { useServiceExtras } from '../../state/useServiceList';
import styles from './ServicesPage.module.css';

const HEADERS: { label: string; align?: 'right' }[] = [
  { label: 'STATUS' },
  { label: 'SERVICE' },
  { label: 'TEAM' },
  { label: 'TYPE' },
  { label: 'REQ/S', align: 'right' },
  { label: 'P95', align: 'right' },
  { label: 'ERR', align: 'right' },
  { label: 'SLO 30D', align: 'right' },
  { label: 'LATENCY 24H' },
];

/** Fixed row height (px, border included); keep in sync with `.row` in the CSS. */
const ROW_H = 54;

export function ServicesPage() {
  const navigate = useStore((s) => s.navigate);
  const search = useStore((s) => s.search);
  const topology = useStore((s) => s.topology);
  const teamFilter = useStore((s) => s.teamFilter);
  const setTeamFilter = useStore((s) => s.setTeamFilter);
  const extras = useServiceExtras();

  const teams = topology?.teams;
  const services = topology?.services;
  const teamName = useMemo(() => new Map((teams ?? []).map((t) => [t.id, t.name])), [teams]);
  const ranked = useMemo(() => rankServiceRows(services ?? [], search, teamFilter), [services, search, teamFilter]);
  const listRef = useRef<HTMLDivElement>(null);
  // numbers update every frame; the order only on a status change, every 15 s,
  // and never under the pointer or keyboard focus
  const rows = useStableRank(ranked, useListHold(listRef));
  const total = services?.length ?? 0;
  const countLabel = rows.length === total ? `${total} services` : `${rows.length} of ${total} services`;

  const scrollRef = useRef<HTMLDivElement>(null);
  const win = useWindowedRows(scrollRef, listRef, ROW_H, rows.length);
  const { focusRow, afterRender } = useWindowedFocus(scrollRef, listRef, ROW_H);
  useLayoutEffect(afterRender);

  const open = useCallback((id: string) => navigate('service', id), [navigate]);
  const kb = useListKeyboard({ count: rows.length, focusRow, onActivate: (i) => open(rows[i].id) });
  // One tab stop: the active row, or the first mounted one if it scrolled away.
  const tabIndex = kb.activeIndex >= win.start && kb.activeIndex < win.end ? kb.activeIndex : win.start;

  return (
    <div className={styles.page} ref={scrollRef}>
      <div className={styles.content}>
        <div className={styles.heading}>
          <div className={styles.headingText}>
            <div className={styles.title}>Services</div>
            <div className={styles.subtitle}>
              {`${countLabel} ${DOT} ${topology?.edges.length ?? 0} learned dependencies ${DOT} sorted by health`}
            </div>
          </div>
          <TeamFilter teams={teams ?? []} value={teamFilter} onChange={setTeamFilter} />
        </div>
        <div className={styles.table} role="table" aria-label="Services" aria-rowcount={rows.length + 1}>
          <div role="rowgroup">
            <div className={`${styles.gridRow} ${styles.headRow}`} role="row" aria-rowindex={1}>
              {HEADERS.map((h, i) => (
                <span
                  key={i}
                  role="columnheader"
                  className={`${styles.headCell} ${h.align === 'right' ? styles.right : ''}`}
                >
                  {/* the status column has no visible heading, only an accessible one */}
                  {i === 0 ? <span className={styles.srOnly}>{h.label}</span> : h.label}
                </span>
              ))}
            </div>
          </div>
          <div
            role="rowgroup"
            ref={listRef}
            // takes focus when the focused row scrolls away and unmounts
            tabIndex={-1}
            className={styles.body}
            style={{ height: win.totalHeight }}
            onKeyDown={kb.onKeyDown}
            onFocus={kb.onFocus}
          >
            <div style={{ transform: `translateY(${win.offset}px)` }}>
              {rows.slice(win.start, win.end).map((r, k) => {
                const index = win.start + k;
                return (
                  <ServiceTableRow
                    key={r.id}
                    row={r}
                    index={index}
                    tabbable={index === tabIndex}
                    extra={extras?.get(r.id)}
                    team={r.teamId != null ? (teamName.get(r.teamId) ?? '--') : '--'}
                    onOpen={open}
                  />
                );
              })}
            </div>
          </div>
          {!rows.length && (
            <div className={styles.empty}>{topology ? 'no services match' : 'waiting for telemetry…'}</div>
          )}
        </div>
      </div>
    </div>
  );
}

const ServiceTableRow = memo(function ServiceTableRow({
  row,
  index,
  tabbable,
  extra,
  team,
  onOpen,
}: {
  row: ServiceRow;
  index: number;
  tabbable: boolean;
  extra: ServiceExtra | undefined;
  team: string;
  onOpen: (id: string) => void;
}) {
  const s = row.svc;
  // SLO from the slow /services refresh when it has arrived, else the structure's.
  const sloAttain = extra ? extra.sloAttain : s.sloAttain;
  const slo = sloView(s.sloTarget, sloAttain);
  return (
    <div
      className={`${styles.gridRow} ${styles.row} hov-row`}
      role="row"
      aria-rowindex={index + 2}
      data-row-index={index}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onOpen(s.id)}
    >
      <span role="cell">
        <span className={`${styles.dot} ${styles[s.status]}`} role="img" aria-label={stLabel(s.status)} />
      </span>
      <span role="cell" className={styles.nameCell}>
        <span className={styles.name}>{s.name}</span>
        <span className={styles.runtime}>
          {s.runtime ?? (s.isExternal ? 'inferred from caller traces' : 'unknown runtime')}
        </span>
      </span>
      <span role="cell" className={styles.team}>
        {team}
      </span>
      <span role="cell" className={styles.type}>
        {TYPE_LABELS[s.type] ?? s.type.toUpperCase()}
      </span>
      <span role="cell" className={styles.metric}>
        {fmtRps(s.metrics.rps)}
      </span>
      <span role="cell" className={styles.metric}>
        {fmtMs(s.metrics.p95)}
      </span>
      <span role="cell" className={`${styles.metric} ${styles[`err${s.status}`]}`}>
        {fmtErr(s.metrics.errPct)}
      </span>
      {/* slo.color is computed by sloView, so it stays inline */}
      <span role="cell" className={styles.metric} style={{ color: slo.color }}>
        {sloAttain == null ? '--' : `${sloAttain.toFixed(2)}%`}
      </span>
      <span role="cell">
        <MiniSpark
          data={extra?.spark}
          color={s.status === 'ok' ? 'var(--faint)' : stColor(s.status)}
          className={styles.spark}
        />
      </span>
    </div>
  );
});
