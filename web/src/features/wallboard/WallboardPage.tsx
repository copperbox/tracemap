import styles from './WallboardPage.module.css';

/**
 * Wallboard: one card per service for at-a-glance incident triage.
 * Scaffolding only for now -- the card grid lands in a follow-up issue, which
 * will consume the store's `search` and `teamFilter` the same way the
 * services list does.
 */
export function WallboardPage() {
  return (
    <div className={styles.page}>
      <div className={styles.content}>
        <div className={styles.title}>Wallboard</div>
        <div className={styles.subtitle}>ONE CARD PER SERVICE</div>
        <div className={styles.placeholder}>Service cards coming soon.</div>
      </div>
    </div>
  );
}
