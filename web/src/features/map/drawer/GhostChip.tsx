import styles from './GhostChip.module.css';

export function GhostChip({ text }: { text: string }) {
  return <div className={styles.chip}>{text}</div>;
}
