import type { ReactNode } from 'react';
import styles from './Field.module.css';

/** Labeled form field wrapper used by the edit-service modal. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      {children}
    </label>
  );
}
