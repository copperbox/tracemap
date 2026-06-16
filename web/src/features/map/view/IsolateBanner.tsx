import styles from './IsolateBanner.module.css';

/**
 * Top-centre pill shown while the map is isolated to a single dependency tree.
 * Names the isolated entity and offers the one way back to the full map (the
 * background click still only deselects, so isolation is never lost by accident).
 */
export function IsolateBanner({ label, onExit }: { label: string; onExit: () => void }) {
  return (
    <div className={styles.banner}>
      <span className={styles.tag}>ISOLATED TREE</span>
      <span className={styles.label} title={label}>
        {label}
      </span>
      <button
        type="button"
        className={`${styles.exit} hov-btn`}
        onClick={(e) => {
          e.stopPropagation();
          onExit();
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        Exit
      </button>
    </div>
  );
}
