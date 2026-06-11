import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { ServiceList } from '../../api/types';
import { TYPE_LABELS } from '../../components/Icon';
import { DOT, fmtErr, fmtMs, fmtRps, jit } from '../../lib/format';
import { sparkPath } from '../../lib/spark';
import { sloView, stColor } from '../../lib/status';
import { useStore } from '../../state/store';

const mono = (px: number, weight = 500): string => `${weight} ${px}px 'JetBrains Mono', monospace`;
const GRID = '16px 1.6fr 110px 130px 80px 80px 70px 80px 130px';

const HEADERS: { label: string; align?: 'right' }[] = [
  { label: '' },
  { label: 'SERVICE' },
  { label: 'TEAM' },
  { label: 'TYPE' },
  { label: 'REQ/S', align: 'right' },
  { label: 'P95', align: 'right' },
  { label: 'ERR', align: 'right' },
  { label: 'SLO 30D', align: 'right' },
  { label: 'LATENCY 24H' },
];

export function ServicesPage() {
  const navigate = useStore((s) => s.navigate);
  const search = useStore((s) => s.search);
  const topology = useStore((s) => s.topology);
  const tick = useStore((s) => s.tick);
  const [data, setData] = useState<ServiceList | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => api.services().then((d) => alive && setData(d)).catch(() => undefined);
    void poll();
    const i = setInterval(poll, 15_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, []);

  const teamName = new Map((topology?.teams ?? []).map((t) => [t.id, t.name]));
  const q = search.trim().toLowerCase();
  const rank = { crit: 0, warn: 1, ok: 2 } as const;
  const rows = (data?.services ?? [])
    .filter((s) => !q || s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
    .sort((a, b) => rank[a.status] - rank[b.status] || b.rps - a.rps);

  return (
    <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '26px 32px' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <div style={{ marginBottom: 16 }}>
          <div style={{ font: "700 20px 'Space Grotesk'" }}>Services</div>
          <div style={{ font: mono(11), color: 'var(--dim)', marginTop: 4 }}>
            {`${data?.services.length ?? 0} services ${DOT} ${data?.edgeCount ?? 0} learned dependencies ${DOT} sorted by health`}
          </div>
        </div>
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, overflow: 'hidden' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: GRID,
              gap: 12,
              alignItems: 'center',
              padding: '11px 18px',
              borderBottom: '1px solid var(--line)',
            }}
          >
            {HEADERS.map((h, i) => (
              <span
                key={i}
                style={{ font: mono(9, 600), letterSpacing: '.14em', color: 'var(--faint)', textAlign: h.align }}
              >
                {h.label}
              </span>
            ))}
          </div>
          {rows.map((s) => {
            const slo = sloView(s.sloTarget, s.sloAttain);
            const c = stColor(s.status);
            return (
              <div
                key={s.id}
                className="hov-row"
                onClick={() => navigate('service', s.id)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: GRID,
                  gap: 12,
                  alignItems: 'center',
                  padding: '11px 18px',
                  borderTop: '1px solid var(--line)',
                  cursor: 'pointer',
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: c, boxShadow: `0 0 8px ${c}` }} />
                <span style={{ minWidth: 0 }}>
                  <span
                    style={{
                      display: 'block',
                      font: "600 13px 'Space Grotesk'",
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {s.name}
                  </span>
                  <span style={{ display: 'block', font: mono(9), color: 'var(--faint)', marginTop: 2 }}>
                    {s.runtime ?? (s.isExternal ? 'inferred from caller traces' : 'unknown runtime')}
                  </span>
                </span>
                <span style={{ font: mono(11), color: 'var(--dim)' }}>
                  {s.teamId != null ? (teamName.get(s.teamId) ?? '--') : '--'}
                </span>
                <span style={{ font: mono(9, 600), letterSpacing: '.1em', color: 'var(--faint)' }}>
                  {TYPE_LABELS[s.type] ?? s.type.toUpperCase()}
                </span>
                <span style={{ font: mono(11.5, 600), textAlign: 'right' }}>{fmtRps(s.rps * jit(s.id, tick))}</span>
                <span style={{ font: mono(11.5, 600), textAlign: 'right' }}>{fmtMs(s.p95)}</span>
                <span style={{ font: mono(11.5, 600), textAlign: 'right', color: s.status === 'ok' ? 'var(--text)' : c }}>
                  {fmtErr(s.errPct)}
                </span>
                <span style={{ font: mono(11.5, 600), textAlign: 'right', color: slo.color }}>
                  {s.sloAttain == null ? '--' : `${s.sloAttain.toFixed(2)}%`}
                </span>
                <svg viewBox="0 0 120 26" preserveAspectRatio="none" style={{ width: 130, height: 26, display: 'block' }}>
                  <path
                    d={sparkPath(s.spark.length > 1 ? s.spark : [0, 0])}
                    fill="none"
                    stroke={s.status === 'ok' ? 'var(--faint)' : c}
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              </div>
            );
          })}
          {!rows.length && (
            <div style={{ padding: '28px 18px', font: mono(11), color: 'var(--faint)', textAlign: 'center' }}>
              {data ? 'no services match' : 'waiting for telemetry\u2026'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
