import type { NeighborEdge } from '../../../api/types';
import { DOT, fmtMs, fmtRps } from '../../../lib/format';
import styles from './NeighborsPanel.module.css';

/** Upstream callers and downstream dependencies, one clickable row per neighbor. */
export function NeighborsPanel({
  up,
  down,
  onOpenService,
}: {
  up: NeighborEdge[];
  down: NeighborEdge[];
  onOpenService: (id: string) => void;
}) {
  const neighborRow = (n: NeighborEdge) => (
    <div
      key={`${n.source}->${n.target}`}
      className={`${styles.row} hov-row`}
      onClick={() => onOpenService(n.otherId)}
    >
      <span className={`${styles.dot} ${styles[n.status]}`} />
      <span className={styles.name}>{n.otherId}</span>
      {n.manual && <span className={styles.manualBadge}>MANUAL</span>}
      <span className={styles.rps}>{fmtRps(n.rps)}/s</span>
      <span className={styles.p95}>{fmtMs(n.p95)}</span>
    </div>
  );

  return (
    <div className={styles.card}>
      <div className={styles.label}>{`CALLED BY ${DOT} ${up.length}`}</div>
      <div className={`${styles.list} ${styles.listSpaced}`}>{up.map(neighborRow)}</div>
      <div className={styles.label}>{`DEPENDS ON ${DOT} ${down.length}`}</div>
      <div className={styles.list}>{down.map(neighborRow)}</div>
    </div>
  );
}
