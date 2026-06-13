import { Sparkline } from '../../../components/Sparkline';
import styles from './SparkRow.module.css';

export function SparkRow({
  label,
  data,
  times,
  color,
  fmt,
}: {
  label: string;
  data: number[] | undefined;
  times: Date[] | undefined;
  color: string;
  fmt: (v: number) => string;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.label}>{label}</div>
      {data && data.length > 1 ? (
        <Sparkline data={data} times={times} color={color} fmt={fmt} dotColor={color} />
      ) : (
        <div className={styles.empty}>collecting{'\u2026'}</div>
      )}
    </div>
  );
}
