import type { ReactNode } from 'react';
import styles from './Card.module.css';

export function Card({
  children,
  variant,
}: {
  children: ReactNode;
  /** 'row': horizontal layout (SLO card); 'column': stacked rows (sparkline cards). */
  variant?: 'row' | 'column';
}) {
  return <div className={`${styles.card} ${variant ? styles[variant] : ''}`}>{children}</div>;
}
