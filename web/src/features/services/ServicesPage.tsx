import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { ServiceList } from '../../api/types';
import { TYPE_LABELS } from '../../components/Icon';
import { DOT, fmtErr, fmtMs, fmtRps, jit } from '../../lib/format';
import { sparkPath } from '../../lib/spark';
import { sloView, stColor } from '../../lib/status';
import { useStore } from '../../state/store';
import styles from './ServicesPage.module.css';

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
    <div className={styles.page}>
      <div className={styles.content}>
        <div className={styles.heading}>
          <div className={styles.title}>Services</div>
          <div className={styles.subtitle}>
            {`${data?.services.length ?? 0} services ${DOT} ${data?.edgeCount ?? 0} learned dependencies ${DOT} sorted by health`}
          </div>
        </div>
        <div className={styles.table}>
          <div className={`${styles.gridRow} ${styles.headRow}`}>
            {HEADERS.map((h, i) => (
              <span key={i} className={`${styles.headCell} ${h.align === 'right' ? styles.right : ''}`}>
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
                className={`${styles.gridRow} ${styles.row} hov-row`}
                onClick={() => navigate('service', s.id)}
              >
                <span className={`${styles.dot} ${styles[s.status]}`} />
                <span className={styles.nameCell}>
                  <span className={styles.name}>{s.name}</span>
                  <span className={styles.runtime}>
                    {s.runtime ?? (s.isExternal ? 'inferred from caller traces' : 'unknown runtime')}
                  </span>
                </span>
                <span className={styles.team}>{s.teamId != null ? (teamName.get(s.teamId) ?? '--') : '--'}</span>
                <span className={styles.type}>{TYPE_LABELS[s.type] ?? s.type.toUpperCase()}</span>
                <span className={styles.metric}>{fmtRps(s.rps * jit(s.id, tick))}</span>
                <span className={styles.metric}>{fmtMs(s.p95)}</span>
                <span className={`${styles.metric} ${styles[`err${s.status}`]}`}>{fmtErr(s.errPct)}</span>
                {/* slo.color is computed by sloView, so it stays inline */}
                <span className={styles.metric} style={{ color: slo.color }}>
                  {s.sloAttain == null ? '--' : `${s.sloAttain.toFixed(2)}%`}
                </span>
                <svg viewBox="0 0 120 26" preserveAspectRatio="none" className={styles.spark}>
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
            <div className={styles.empty}>{data ? 'no services match' : 'waiting for telemetry\u2026'}</div>
          )}
        </div>
      </div>
    </div>
  );
}
