import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { LogoIcon, SearchIcon } from './Icon';
import { PreferencesMenu } from './PreferencesMenu';
import { servicesByStatus } from '../lib/healthSummary';
import { DOT, ELLIPSIS, fmtErr, fmtMs } from '../lib/format';
import type { Status, TopologyService } from '../api/types';
import styles from './TopBar.module.css';

const STATUS_NOUN: Record<Status, string> = {
  ok: 'healthy',
  warn: 'degraded',
  crit: 'critical',
};

function HealthChip({
  status,
  count,
  expanded,
  onToggle,
}: {
  status: Status;
  count: number;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const base = `${styles.healthChip} ${styles[status]}`;
  // The ok pill (and any zero count) stays inert text; only the problem counts
  // become a button that opens the offending-services list.
  if (!onToggle) {
    return (
      <div className={base}>
        <span className={styles.healthDot} />
        {count}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`${base} ${styles.healthChipBtn} ${expanded ? styles.healthChipOpen : ''}`}
      onClick={onToggle}
      aria-haspopup="listbox"
      aria-expanded={expanded}
      aria-label={`${count} ${STATUS_NOUN[status]} ${count === 1 ? 'service' : 'services'}`}
      title={`${count} ${STATUS_NOUN[status]}`}
    >
      <span className={styles.healthDot} />
      {count}
    </button>
  );
}

function HealthPopover({
  status,
  services,
  onPick,
}: {
  status: Status;
  services: TopologyService[];
  onPick: (id: string) => void;
}) {
  const rows = servicesByStatus(services, status);
  return (
    <div className={styles.healthPopover} role="listbox" aria-label={`${STATUS_NOUN[status]} services`}>
      <div className={styles.healthPopoverHead}>
        {rows.length} {STATUS_NOUN[status]}
      </div>
      <div className={styles.healthPopoverList}>
        {rows.map((s) => (
          <button
            type="button"
            key={s.id}
            role="option"
            aria-selected={false}
            className={styles.healthRow}
            onClick={() => onPick(s.id)}
          >
            <span className={`${styles.rowDot} ${styles[status]}`} />
            <span className={styles.healthRowName}>{s.name}</span>
            <span className={styles.healthRowMetrics}>
              {fmtErr(s.errPct)} {DOT} {fmtMs(s.p95)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function TopBar() {
  const view = useStore((s) => s.view);
  const navigate = useStore((s) => s.navigate);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const topology = useStore((s) => s.topology);
  const ingesting = useStore((s) => s.ingesting);
  const revealOnMap = useStore((s) => s.revealOnMap);

  const services = topology?.services ?? [];
  const counts = { ok: 0, warn: 0, crit: 0 };
  for (const s of services) counts[s.status] += 1;

  const [openStatus, setOpenStatus] = useState<Status | null>(null);
  const chipsRef = useRef<HTMLDivElement>(null);

  // Dismiss the health popover on Escape or a click outside the chip cluster.
  useEffect(() => {
    if (!openStatus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenStatus(null);
    };
    const onDown = (e: MouseEvent) => {
      if (chipsRef.current && !chipsRef.current.contains(e.target as Node)) setOpenStatus(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [openStatus]);

  // If a poll drains the open status to zero, close the (now empty) popover.
  const openCount = openStatus ? counts[openStatus] : 0;
  useEffect(() => {
    if (openStatus && openCount === 0) setOpenStatus(null);
  }, [openStatus, openCount]);

  const toggleStatus = (status: Status) =>
    setOpenStatus((cur) => (cur === status ? null : status));

  const pick = (id: string) => {
    setOpenStatus(null);
    revealOnMap(id);
  };

  const navPill = (label: string, active: boolean, onClick: () => void) => (
    <div
      onClick={onClick}
      className={active ? `${styles.navPill} ${styles.navPillActive}` : styles.navPill}
    >
      {label}
    </div>
  );

  return (
    <div className={styles.bar}>
      <div className={styles.brand}>
        <LogoIcon />
        <div>
          <div className={styles.title}>TRACEMAP</div>
          <div className={styles.subtitle}>{`TOPOLOGY ${DOT} DERIVED FROM OTEL`}</div>
        </div>
      </div>
      <div className={styles.divider} />
      <div className={styles.nav}>
        {navPill('Service map', view === 'map', () => navigate('map'))}
        {navPill('Services', view === 'services', () => navigate('services'))}
        {navPill('Wallboard', view === 'wallboard', () => navigate('wallboard'))}
      </div>
      <div className={styles.searchBox}>
        <SearchIcon />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Filter services${ELLIPSIS}`}
          className={styles.searchInput}
        />
      </div>
      <div className={styles.spacer} />
      <div className={styles.chips} ref={chipsRef}>
        <HealthChip status="ok" count={counts.ok} />
        <HealthChip
          status="warn"
          count={counts.warn}
          expanded={openStatus === 'warn'}
          onToggle={counts.warn > 0 ? () => toggleStatus('warn') : undefined}
        />
        <HealthChip
          status="crit"
          count={counts.crit}
          expanded={openStatus === 'crit'}
          onToggle={counts.crit > 0 ? () => toggleStatus('crit') : undefined}
        />
        {openStatus && counts[openStatus] > 0 && (
          <HealthPopover status={openStatus} services={services} onPick={pick} />
        )}
      </div>
      <div className={styles.ingest}>
        <div className={ingesting ? `${styles.ingestDot} ${styles.ingestDotOn}` : styles.ingestDot} />
        <span className={styles.ingestLabel}>{ingesting ? 'INGESTING' : 'IDLE'}</span>
      </div>
      <div className={styles.divider} />
      <PreferencesMenu />
    </div>
  );
}
