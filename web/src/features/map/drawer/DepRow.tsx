import { ChevronIcon } from '../../../components/Icon';
import styles from './DepRow.module.css';

export function DepRow({
  name,
  statusColor,
  right,
  onClick,
}: {
  name: string;
  statusColor: string;
  right: string;
  onClick: () => void;
}) {
  return (
    <div
      className={`${styles.row} hov-row`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <span className={styles.dot} style={{ background: statusColor }} />
      <span className={styles.name}>{name}</span>
      <span className={styles.right}>{right}</span>
      <ChevronIcon />
    </div>
  );
}
