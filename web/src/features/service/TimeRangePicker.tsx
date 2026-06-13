import { useEffect, useRef, useState } from 'react';
import { QUICK_RANGES, rangeLabel, type TimeRange } from '../../lib/timerange';
import styles from './TimeRangePicker.module.css';

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TimeRangePicker({ value, onChange }: { value: TimeRange; onChange: (r: TimeRange) => void }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(toLocalInput(Date.now() - 24 * 3600_000));
  const [to, setTo] = useState(toLocalInput(Date.now()));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={ref} className={styles.wrap}>
      <div className={`${styles.trigger} hov-btn`} onClick={() => setOpen(!open)}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M6 3.2 V6 L8 7.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        {rangeLabel(value)}
      </div>
      {open && (
        <div className={styles.popover}>
          <div className={styles.sectionLabel}>QUICK RANGES</div>
          <div className={styles.quickGrid}>
            {QUICK_RANGES.map((q) => {
              const active = value.kind === 'quick' && value.ms === q.ms;
              return (
                <div
                  key={q.label}
                  className={`${styles.quick} ${active ? styles.active : ''} hov-row`}
                  onClick={() => {
                    onChange({ kind: 'quick', label: q.label, ms: q.ms });
                    setOpen(false);
                  }}
                >
                  {q.label}
                </div>
              );
            })}
          </div>
          <div className={styles.sectionLabel}>ABSOLUTE RANGE</div>
          <div className={styles.absCol}>
            {(
              [
                ['From', from, setFrom],
                ['To', to, setTo],
              ] as [string, string, (v: string) => void][]
            ).map(([label, val, setter]) => (
              <label key={label} className={styles.absRow}>
                <span className={styles.absLabel}>{label}</span>
                <input
                  type="datetime-local"
                  value={val}
                  onChange={(e) => setter(e.target.value)}
                  className={styles.absInput}
                />
              </label>
            ))}
            <div
              className={`${styles.applyBtn} hov-accent`}
              onClick={() => {
                const f = new Date(from).getTime();
                const t = new Date(to).getTime();
                if (Number.isFinite(f) && Number.isFinite(t) && f < t) {
                  onChange({ kind: 'absolute', from: f, to: t });
                  setOpen(false);
                }
              }}
            >
              Apply range
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
