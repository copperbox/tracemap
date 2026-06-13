import { stLabel } from '../../../lib/status';
import styles from './StatusPill.module.css';

export function StatusPill({ status }: { status: 'ok' | 'warn' | 'crit' }) {
  return (
    <div className={`${styles.pill} ${styles[status]}`}>
      <span className={styles.dot} />
      {stLabel(status)}
    </div>
  );
}
