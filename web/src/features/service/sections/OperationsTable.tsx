import type { ServiceDetail } from '../../../api/types';
import { fmtErr, fmtMs, fmtRps } from '../../../lib/format';
import { errLevel } from '../errLevel';
import styles from './OperationsTable.module.css';

const HEADERS = ['OPERATION', 'REQ/S', 'P95', 'P99', 'ERR'];

/** Per-operation throughput, latency, and error-rate table. */
export function OperationsTable({ operations }: { operations: ServiceDetail['operations'] }) {
  return (
    <div className={styles.card}>
      <div className={styles.label}>TOP OPERATIONS</div>
      <div className={styles.headRow}>
        {HEADERS.map((h, i) => (
          <span key={h} className={`${styles.headCell} ${i ? styles.headCellRight : ''}`}>
            {h}
          </span>
        ))}
      </div>
      {operations.map((o) => (
        <div key={o.name} className={styles.row}>
          <span className={styles.opName}>{o.name}</span>
          <span className={styles.cell}>{fmtRps(o.rps)}</span>
          <span className={styles.cell}>{fmtMs(o.p95)}</span>
          <span className={styles.cell}>{fmtMs(o.p99)}</span>
          <span className={`${styles.err} ${styles[errLevel(o.errPct)]}`}>
            {o.errPct == null ? '--' : fmtErr(o.errPct)}
          </span>
        </div>
      ))}
      {!operations.length && <div className={styles.empty}>no operations observed in this range</div>}
    </div>
  );
}
