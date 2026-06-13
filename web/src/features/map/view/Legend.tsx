import { ARROW } from '../../../lib/format';
import styles from './Legend.module.css';

/** Static legend in the bottom-left corner of the canvas. */
export function Legend() {
  return (
    <div className={styles.legend}>
      {(
        [
          [styles.dotOk, 'healthy'],
          [styles.dotWarn, 'degraded'],
          [styles.dotCrit, 'critical'],
        ] as const
      ).map(([dotCls, label]) => (
        <div key={label} className={styles.row}>
          <span className={`${styles.dot} ${dotCls}`} />
          {label}
        </div>
      ))}
      <div className={styles.row}>
        <span className={styles.dashedLine} />
        infra / external
      </div>
      <div className={styles.row}>
        <svg width="14" height="10" viewBox="0 0 14 10" className={styles.flowIcon}>
          <line x1="0" y1="5" x2="9" y2="5" stroke="var(--accent)" strokeWidth="1.6" opacity="0.7" />
          <polygon points="14,5 8,1.8 8,8.2" fill="var(--accent)" opacity="0.85" />
        </svg>
        {`data flow ${ARROW} into dependent`}
      </div>
      <div className={styles.row}>
        <span className={styles.frameSample} />
        team frame
      </div>
    </div>
  );
}
