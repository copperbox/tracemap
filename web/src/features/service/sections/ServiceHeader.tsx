import type { ServiceDetail } from '../../../api/types';
import { TYPE_LABELS } from '../../../components/Icon';
import { SloRing } from '../../../components/SloRing';
import { DOT, fmtAgo } from '../../../lib/format';
import { stLabel } from '../../../lib/status';
import styles from './ServiceHeader.module.css';

/** Service identity block: name, status/team/type pills, metadata line, SLO ring. */
export function ServiceHeader({
  service,
  upCount,
  downCount,
}: {
  service: ServiceDetail['service'];
  upCount: number;
  downCount: number;
}) {
  const s = service;
  return (
    <div className={styles.header}>
      <div className={styles.main}>
        <div className={styles.titleRow}>
          <div className={styles.title}>{s.name}</div>
          <div className={`${styles.statusPill} ${styles[s.status]}`}>
            <span className={styles.statusDot} />
            {stLabel(s.status)}
          </div>
          <div className={styles.teamPill}>{s.teamName ?? 'unassigned'}</div>
          <div className={styles.typePill}>{TYPE_LABELS[s.type] ?? s.type.toUpperCase()}</div>
        </div>
        <div className={styles.meta}>
          {[
            s.runtime,
            s.region,
            `${downCount} downstream ${DOT} ${upCount} upstream`,
            `last seen ${fmtAgo(s.lastSeen)} ago`,
          ]
            .filter(Boolean)
            .join(` ${DOT} `)}
        </div>
        {s.description && <div className={styles.description}>{s.description}</div>}
      </div>
      <SloRing target={s.sloTarget} attain={s.sloAttain} size={74} caption="SLO 30D" />
    </div>
  );
}
