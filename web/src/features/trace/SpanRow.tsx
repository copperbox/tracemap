import { fmtMs } from '../../lib/format';
import type { Row } from './buildRows';
import styles from './SpanRow.module.css';

/** One waterfall row: indented span name, timeline bar, expandable attributes. */
export function SpanRow({
  row,
  totalMs,
  color,
  isOpen,
  onToggle,
}: {
  row: Row;
  totalMs: number;
  color: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const left = (row.startMs / totalMs) * 100;
  const width = Math.max(0.8, (row.span.durationMs / totalMs) * 100);
  const attrs: [string, string][] = [
    ['span_id', row.span.spanId],
    ['service.name', row.span.serviceId],
    ['duration', fmtMs(row.span.durationMs)],
    ...Object.entries(row.span.attrs).map(
      ([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as [string, string],
    ),
    ['otel.status_code', row.span.isError ? 'ERROR' : 'OK'],
  ];

  return (
    <div className={`${styles.row} ${isOpen ? styles.open : ''}`} onClick={onToggle}>
      <div className={styles.main}>
        {/* indentation tracks span depth */}
        <div className={styles.left} style={{ paddingLeft: 16 + row.depth * 16 }}>
          <span className={styles.dot} style={{ background: color }} />
          <span className={styles.name}>{row.span.name}</span>
          <span className={styles.service}>{row.span.serviceId}</span>
        </div>
        <div className={styles.timeline}>
          <div
            className={styles.bar}
            style={{
              left: `${left.toFixed(2)}%`,
              width: `${width.toFixed(2)}%`,
              background: `color-mix(in srgb, ${color} 30%, transparent)`,
              border: `1px solid ${color}`,
            }}
          />
          {/* duration label flips to the left edge of the bar near the right side */}
          <div
            className={styles.durLabel}
            style={{
              left: left + width > 84 ? `calc(${left.toFixed(2)}% - 56px)` : `calc(${(left + width).toFixed(2)}% + 8px)`,
            }}
          >
            {fmtMs(row.span.durationMs)}
          </div>
        </div>
      </div>
      {isOpen && (
        <div className={styles.attrs}>
          {attrs.map(([key, val]) => (
            <div key={key} className={styles.attrRow}>
              <span className={styles.attrKey}>{key}</span>
              <span className={styles.attrVal}>{val}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
