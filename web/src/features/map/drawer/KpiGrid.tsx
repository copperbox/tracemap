import styles from './KpiGrid.module.css';

export function KpiGrid({ items }: { items: { label: string; value: string; color?: string }[] }) {
  return (
    <div className={styles.grid}>
      {items.map((k) => (
        <div key={k.label} className={styles.cell}>
          <div className={styles.label}>{k.label}</div>
          <div className={styles.value} style={k.color ? { color: k.color } : undefined}>
            {k.value}
          </div>
        </div>
      ))}
    </div>
  );
}
