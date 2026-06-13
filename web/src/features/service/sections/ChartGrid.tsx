import type { SeriesPoint } from '../../../api/types';
import { BigChart } from '../../../components/BigChart';
import { HoverSync } from '../../../components/hoverSync';
import { DOT, fmtMs, fmtRps } from '../../../lib/format';
import { rangeLabel, type TimeRange } from '../../../lib/timerange';
import { errLevel } from '../errLevel';
import { rangeEdgeLabels } from '../rangeEdges';
import styles from './ChartGrid.module.css';

const LEGEND = [
  ['swatchP50', 'p50'],
  ['swatchP95', 'p95'],
  ['swatchP99', 'p99'],
] as const;

/** Bar color is a BigChart prop (JS value), so the mapping lives here, not in CSS. */
const BAR_COLORS = { crit: 'var(--crit)', warn: 'var(--warn)', ok: 'var(--line2)' } as const;

/** Latency, throughput, and error-rate charts for the selected time range. */
export function ChartGrid({ series, range }: { series: SeriesPoint[]; range: TimeRange }) {
  const times = series.map((p) => new Date(p.t));
  const latMax = Math.max(1e-9, ...series.map((p) => p.p99 ?? p.p95 ?? 0));
  const errMax = Math.max(0.5, ...series.map((p) => p.errPct ?? 0));
  const edges = rangeEdgeLabels(range);
  const rangeCaption = rangeLabel(range).toUpperCase();

  const axis = (middle?: string) => (
    <div className={styles.axis}>
      <span>{edges.start}</span>
      {middle != null && <span>{middle}</span>}
      <span>{edges.end}</span>
    </div>
  );

  return (
    <HoverSync>
      <div className={styles.grid}>
        <div className={styles.card}>
          <div className={styles.latencyHead}>
            <div className={styles.label}>{`LATENCY ${DOT} ${rangeCaption}`}</div>
            <div className={styles.spacer} />
            <div className={styles.legend}>
              {LEGEND.map(([cls, lab]) => (
                <span key={lab} className={styles.legendItem}>
                  <span className={`${styles.swatch} ${styles[cls]}`} />
                  {lab}
                </span>
              ))}
            </div>
          </div>
          <BigChart
            lines={[
              { label: 'p50', color: 'var(--faint)', values: series.map((p) => p.p50), width: 1.3 },
              { label: 'p95', color: 'var(--accent)', values: series.map((p) => p.p95), width: 1.7 },
              { label: 'p99', color: 'var(--warn)', values: series.map((p) => p.p99), width: 1.3, opacity: 0.85 },
            ]}
            times={times}
            fmt={fmtMs}
            gridLines={4}
            max={latMax}
          />
          {axis(`${fmtMs(latMax)} peak`)}
        </div>
        <div className={styles.card}>
          <div className={`${styles.label} ${styles.labelSpaced}`}>{`THROUGHPUT ${DOT} ${rangeCaption}`}</div>
          <BigChart
            lines={[{ label: 'req/s', color: 'var(--accent)', values: series.map((p) => p.rps), width: 1.7 }]}
            area
            times={times}
            fmt={(v) => `${fmtRps(v)}/s`}
          />
          {axis()}
        </div>
        <div className={styles.card}>
          <div className={`${styles.label} ${styles.labelSpaced}`}>{`ERROR RATE ${DOT} ${rangeCaption}`}</div>
          <BigChart
            bars={{
              label: 'error rate',
              color: (v: number) => BAR_COLORS[errLevel(v)],
              values: series.map((p) => p.errPct),
            }}
            times={times}
            fmt={(v) => `${v.toFixed(2)}%`}
            max={errMax}
          />
          {axis()}
        </div>
      </div>
    </HoverSync>
  );
}
