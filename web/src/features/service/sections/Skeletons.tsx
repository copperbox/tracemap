import styles from './Skeletons.module.css';

/** Shimmering placeholder; size comes from the composing section's class. */
function Block({ className }: { className?: string }) {
  return <div className={`${styles.block} ${className ?? ''}`} />;
}

/** Identity block placeholder: title, pill row, metadata line, SLO ring. */
export function HeaderSkeleton() {
  return (
    <div className={styles.header}>
      <div className={styles.headerMain}>
        <Block className={styles.title} />
        <div className={styles.pillRow}>
          <Block className={styles.pill} />
          <Block className={styles.pill} />
          <Block className={styles.pill} />
        </div>
        <Block className={styles.meta} />
      </div>
      <Block className={styles.ring} />
    </div>
  );
}

/** Four KPI cards. */
export function KpiSkeleton() {
  return (
    <div className={styles.kpiGrid}>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={styles.card}>
          <Block className={styles.kpiLabel} />
          <Block className={styles.kpiValue} />
          <Block className={styles.kpiSub} />
        </div>
      ))}
    </div>
  );
}

/** Three charts; the body block matches BigChart's 150px height. */
export function ChartSkeleton() {
  return (
    <div className={styles.chartGrid}>
      {[0, 1, 2].map((i) => (
        <div key={i} className={styles.card}>
          <Block className={styles.chartLabel} />
          <Block className={styles.chartBody} />
        </div>
      ))}
    </div>
  );
}

/** Callers and dependencies card. */
export function NeighborsSkeleton() {
  return (
    <div className={styles.card}>
      <Block className={styles.panelLabel} />
      <div className={styles.rows}>
        {[0, 1, 2].map((i) => (
          <Block key={i} className={styles.row} />
        ))}
      </div>
      <Block className={styles.panelLabel} />
      <div className={styles.rowsLast}>
        {[0, 1].map((i) => (
          <Block key={i} className={styles.row} />
        ))}
      </div>
    </div>
  );
}

/** Top-operations table card. */
export function OperationsSkeleton() {
  return (
    <div className={styles.card}>
      <Block className={styles.panelLabel} />
      <div className={styles.rowsLast}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Block key={i} className={styles.row} />
        ))}
      </div>
    </div>
  );
}

/** Top-erroring-operations card. */
export function ErrorsSkeleton() {
  return (
    <div className={styles.card}>
      <Block className={styles.panelLabel} />
      <div className={styles.rowsLast}>
        {[0, 1, 2].map((i) => (
          <Block key={i} className={styles.rowTall} />
        ))}
      </div>
    </div>
  );
}

/** Recent-traces table card. */
export function TracesSkeleton() {
  return (
    <div className={styles.card}>
      <Block className={styles.panelLabel} />
      <div className={styles.rowsLast}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Block key={i} className={styles.row} />
        ))}
      </div>
    </div>
  );
}
