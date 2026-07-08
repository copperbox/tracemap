import type { MouseEvent } from 'react';
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
  /** Omit to render the row inert (no hover affordance, no click). */
  onClick?: () => void;
}) {
  const handleClick = onClick
    ? (e: MouseEvent) => {
        e.stopPropagation();
        onClick();
      }
    : undefined;

  return (
    <div className={onClick ? `${styles.row} hov-row` : styles.row} onClick={handleClick}>
      <span className={styles.dot} style={{ background: statusColor }} />
      <span className={styles.name}>{name}</span>
      <span className={styles.right}>{right}</span>
      <ChevronIcon />
    </div>
  );
}
