import { sloView } from '../lib/status';
import styles from './SloRing.module.css';

export function SloRing({
  target,
  attain,
  size = 62,
  caption,
}: {
  target: number;
  attain: number | null;
  size?: number;
  caption?: string;
}) {
  const slo = sloView(target, attain);
  return (
    <svg width={size} height={size} viewBox="0 0 62 62" className={styles.ring}>
      <circle cx="31" cy="31" r="26" fill="none" stroke="var(--line)" strokeWidth="4" />
      <circle
        cx="31"
        cy="31"
        r="26"
        fill="none"
        stroke={slo.color}
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={slo.dash}
        transform="rotate(-90 31 31)"
      />
      {caption ? (
        <>
          <text x="31" y="29" textAnchor="middle" fill="var(--text)" className={styles.pct}>
            {slo.pct}
          </text>
          <text x="31" y="40" textAnchor="middle" fill="var(--faint)" className={styles.caption}>
            {caption}
          </text>
        </>
      ) : (
        <text x="31" y="35" textAnchor="middle" fill="var(--text)" className={styles.pctSolo}>
          {slo.pct}
        </text>
      )}
    </svg>
  );
}
