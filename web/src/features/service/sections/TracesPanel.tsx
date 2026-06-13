import type { TraceListItem } from '../../../api/types';
import { DOT, fmtAgo, fmtMs } from '../../../lib/format';
import styles from './TracesPanel.module.css';

const HEADERS = ['TRACE ID', 'ROOT OPERATION', 'DURATION', 'SPANS', 'AGE'];

/** Recent traces within the selected range; rows open the trace waterfall. */
export function TracesPanel({
  traces,
  onOpenTrace,
  filterOp,
  onClearFilter,
}: {
  traces: TraceListItem[];
  onOpenTrace: (traceId: string) => void;
  /** When set, the list is restricted to traces where this operation errored. */
  filterOp?: string | null;
  onClearFilter?: () => void;
}) {
  const maxTraceDur = Math.max(1, ...traces.map((t) => t.durationMs));

  return (
    <div className={styles.card}>
      <div className={styles.headBar}>
        <div className={styles.label}>RECENT TRACES</div>
        {filterOp && (
          <button type="button" className={`${styles.filterChip} hov-accent`} onClick={onClearFilter}>
            <span className={styles.filterLabel}>{`erroring: ${filterOp}`}</span>
            <span className={styles.filterX}>x</span>
          </button>
        )}
        <div className={styles.spacer} />
        <div className={styles.hint}>
          {filterOp ? 'click the filter to clear' : `within selected range ${DOT} click to inspect`}
        </div>
      </div>
      <div className={styles.headRow}>
        <span />
        {HEADERS.map((h, i) => (
          <span key={h} className={`${styles.headCell} ${i >= 3 ? styles.headCellRight : ''}`}>
            {h}
          </span>
        ))}
      </div>
      {traces.map((t) => (
        <div key={t.traceId} className={`${styles.row} hov-row`} onClick={() => onOpenTrace(t.traceId)}>
          <span className={`${styles.dot} ${t.status === 'error' ? styles.error : styles.ok}`} />
          <span className={styles.traceId}>{t.traceId.slice(0, 16)}</span>
          <span className={styles.rootOp}>{t.rootOperation}</span>
          <span className={styles.durationCell}>
            {/* bar width scales with the slowest trace in the list */}
            <span
              className={styles.durationBar}
              style={{ width: Math.max(4, Math.round((t.durationMs / maxTraceDur) * 130)) }}
            />
            <span className={styles.duration}>{fmtMs(t.durationMs)}</span>
          </span>
          <span className={styles.spanCount}>{t.spanCount}</span>
          <span className={styles.age}>{fmtAgo(t.time)}</span>
        </div>
      ))}
      {!traces.length && (
        <div className={styles.empty}>
          {filterOp ? `no traces with erroring ${filterOp} in this range` : 'no traces in this range'}
        </div>
      )}
    </div>
  );
}
