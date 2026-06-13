import type { ReactNode } from 'react';
import styles from './FooterButton.module.css';

export function FooterButton({
  primary,
  active,
  onClick,
  children,
  flex,
}: {
  primary?: boolean;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  flex?: boolean;
}) {
  const cls = primary
    ? `${styles.btn} ${styles.primary} hov-accent`
    : [styles.btn, styles.secondary, active ? styles.active : '', flex ? styles.flexible : '', 'hov-btn']
        .filter(Boolean)
        .join(' ');
  return (
    <div
      className={cls}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </div>
  );
}
