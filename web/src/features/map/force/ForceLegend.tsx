import { stColor } from '../../../lib/status';
import styles from './ForceGraph.module.css';

/** Legend for the communities view: what node color, size, and ring mean. */
export function ForceLegend({ communityCount }: { communityCount: number }) {
  return (
    <div className={styles.legend}>
      <div className={styles.row}>
        <span className={styles.communityChip} />
        {`color = community (${communityCount})`}
      </div>
      <div className={styles.row}>
        <span className={styles.sizes}>
          <span className={styles.sizeDot} style={{ width: 5, height: 5 }} />
          <span className={styles.sizeDot} style={{ width: 9, height: 9 }} />
          <span className={styles.sizeDot} style={{ width: 13, height: 13 }} />
        </span>
        size = traffic
      </div>
      <div className={styles.row}>
        <span className={styles.swatch} style={{ background: stColor('warn') }} />
        degraded
      </div>
      <div className={styles.row}>
        <span className={styles.swatch} style={{ background: stColor('crit') }} />
        critical
      </div>
    </div>
  );
}
