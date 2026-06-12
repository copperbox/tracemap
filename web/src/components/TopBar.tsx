import { useStore } from '../state/store';
import { LogoIcon, SearchIcon, ThemeIcon } from './Icon';

const mono = (px: number, weight = 500): string => `${weight} ${px}px 'JetBrains Mono', monospace`;

function HealthChip({ color, bg, count }: { color: string; bg: string; count: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        background: bg,
        font: mono(11, 600),
        color,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block' }} />
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
      style={{
        padding: '7px 14px',
        borderRadius: 8,
        font: "600 12px 'Space Grotesk'",
        cursor: 'pointer',
        background: active ? 'var(--accent-dim)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--dim)',
      }}
    >
      {label}
    </div>
  );

  return (
    <div
      style={{
        height: 56,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 18px',
        background: 'var(--bg2)',
        borderBottom: '1px solid var(--line)',
        position: 'relative',
        zIndex: 30,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <LogoIcon />
        <div>
          <div style={{ font: "700 13px 'Space Grotesk'", letterSpacing: '.22em' }}>TRACEMAP</div>
          <div style={{ font: mono(8.5), letterSpacing: '.12em', color: 'var(--faint)', marginTop: 1 }}>
            {'TOPOLOGY \u00B7 DERIVED FROM OTEL'}
          </div>
        </div>
      </div>
      <div style={{ width: 1, height: 24, background: 'var(--line)' }} />
      <div style={{ display: 'flex', gap: 4 }}>
        {navPill('Service map', view === 'map', () => navigate('map'))}
        {navPill('Services', view === 'services', () => navigate('services'))}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'var(--panel2)',
          border: '1px solid var(--line)',
          borderRadius: 9,
          padding: '0 12px',
          height: 34,
          width: 250,
        }}
      >
        <SearchIcon />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={'Filter services\u2026'}
          style={{
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--text)',
            font: mono(12),
            width: '100%',
          }}
        />
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <HealthChip color="var(--ok)" bg="var(--okbg)" count={counts.ok} />
        <HealthChip color="var(--warn)" bg="var(--warnbg)" count={counts.warn} />
        <HealthChip color="var(--crit)" bg="var(--critbg)" count={counts.crit} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 4px' }}>
        <div
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: ingesting ? 'var(--accent)' : 'var(--faint)',
            animation: ingesting ? 'pulseDot 2s ease-in-out infinite' : 'none',
          }}
        />
        <span style={{ font: mono(9.5, 600), letterSpacing: '.14em', color: 'var(--dim)' }}>
          {ingesting ? 'INGESTING' : 'IDLE'}
        </span>
      </div>
      <div style={{ width: 1, height: 24, background: 'var(--line)' }} />
      <div
        className="hov-btn"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          border: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          color: 'var(--dim)',
        }}
      >
        <ThemeIcon theme={theme} />
      </div>
    </div>
  );
}
