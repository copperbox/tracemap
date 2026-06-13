import type { ServiceDetail } from '../../../api/types';
import { DOT, fmtErr, fmtMs, fmtRps, jit } from '../../../lib/format';
import { sloView, stColor } from '../../../lib/status';
import styles from './KpiCards.module.css';

/** The four headline KPI cards: throughput, latency, error rate, SLO attainment. */
export function KpiCards({ detail, tick }: { detail: ServiceDetail; tick: number }) {
  const s = detail.service;
  const k = detail.kpis;
  const slo = sloView(s.sloTarget, s.sloAttain);
  const c = stColor(s.status);

  const kpis = [
    { label: 'THROUGHPUT', value: `${fmtRps(k.rps * jit(s.id, tick))}/s`, sub: 'avg over selected range', color: 'var(--text)' },
    {
      label: 'LATENCY P95',
      value: fmtMs(k.p95 == null ? null : k.p95 * jit(s.id + 'l', tick, 0.06)),
      sub: `p50 ${fmtMs(k.p50)} ${DOT} p99 ${fmtMs(k.p99)}`,
      color: s.status === 'ok' ? 'var(--text)' : c,
    },
    {
      label: 'ERROR RATE',
      value: fmtErr(k.errPct),
      sub: s.status === 'ok' ? 'within baseline' : 'above baseline',
      color: s.status === 'ok' ? 'var(--text)' : c,
    },
    {
      label: 'SLO ATTAINMENT',
      value: s.sloAttain == null ? '--' : `${s.sloAttain.toFixed(2)}%`,
      sub: `target ${s.sloTarget}% ${DOT} 30 days`,
      color: slo.color,
    },
  ];

  return (
    <div className={styles.grid}>
      {kpis.map((kpi) => (
        <div key={kpi.label} className={styles.card}>
          <div className={styles.label}>{kpi.label}</div>
          <div className={styles.value} style={{ color: kpi.color }}>
            {kpi.value}
          </div>
          <div className={styles.sub}>{kpi.sub}</div>
        </div>
      ))}
    </div>
  );
}
