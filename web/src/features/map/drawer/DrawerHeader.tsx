import type { ReactNode } from 'react';
import { CloseIcon } from '../../../components/Icon';
import styles from './DrawerHeader.module.css';

export function DrawerHeader({
  label,
  title,
  pills,
  meta,
  onClose,
}: {
  label: string;
  title: ReactNode;
  pills: ReactNode;
  meta?: string;
  onClose: () => void;
}) {
  return (
    <div className={styles.header}>
      <div className={styles.topRow}>
        <div className={styles.label}>{label}</div>
        <div className={styles.spacer} />
        <div className={`${styles.closeBtn} hov-btn`} onClick={onClose}>
          <CloseIcon />
        </div>
      </div>
      <div className={styles.title}>{title}</div>
      <div className={styles.pills}>{pills}</div>
      {meta && <div className={styles.meta}>{meta}</div>}
    </div>
  );
}
