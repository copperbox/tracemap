import { useStore } from '../state/store';
import { LogoIcon, SearchIcon, ThemeIcon } from './Icon';
import styles from './TopBar.module.css';

function HealthChip({ status, count }: { status: 'ok' | 'warn' | 'crit'; count: number }) {
  return (
    <div className={`${styles.healthChip} ${styles[status]}`}>
      <span className={styles.healthDot} />
      {count}
    </div>
  );
}

export function TopBar() {
  const view = useStore((s) => s.view);
  const navigate = useStore((s) => s.navigate);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const topology = useStore((s) => s.topology);
  const ingesting = useStore((s) => s.ingesting);

  const counts = { ok: 0, warn: 0, crit: 0 };
  for (const s of topology?.services ?? []) counts[s.status] += 1;

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
          <div className={styles.subtitle}>{'TOPOLOGY \u00B7 DERIVED FROM OTEL'}</div>
        </div>
      </div>
      <div className={styles.divider} />
      <div className={styles.nav}>
        {navPill('Service map', view === 'map', () => navigate('map'))}
        {navPill('Services', view === 'services', () => navigate('services'))}
      </div>
      <div className={styles.searchBox}>
        <SearchIcon />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={'Filter services\u2026'}
          className={styles.searchInput}
        />
      </div>
      <div className={styles.spacer} />
      <div className={styles.chips}>
        <HealthChip status="ok" count={counts.ok} />
        <HealthChip status="warn" count={counts.warn} />
        <HealthChip status="crit" count={counts.crit} />
      </div>
      <div className={styles.ingest}>
        <div className={ingesting ? `${styles.ingestDot} ${styles.ingestDotOn}` : styles.ingestDot} />
        <span className={styles.ingestLabel}>{ingesting ? 'INGESTING' : 'IDLE'}</span>
      </div>
      <div className={styles.divider} />
      <div
        className={`${styles.themeBtn} hov-btn`}
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      >
        <ThemeIcon theme={theme} />
      </div>
    </div>
  );
}
