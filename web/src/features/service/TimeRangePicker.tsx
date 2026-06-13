import { useEffect, useRef, useState } from 'react';
import { QUICK_RANGES, rangeLabel, type TimeRange } from '../../lib/timerange';

const mono = (px: number, weight = 500): string => `${weight} ${px}px 'JetBrains Mono', monospace`;

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
    <div ref={ref} style={{ position: 'relative' }}>
      <div
        className="hov-btn"
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 12px',
          borderRadius: 9,
          border: '1px solid var(--line)',
          background: 'var(--panel2)',
          color: 'var(--dim)',
          font: mono(11, 600),
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M6 3.2 V6 L8 7.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        {rangeLabel(value)}
      </div>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            width: 320,
            background: 'var(--bg2)',
            border: '1px solid var(--line2)',
            borderRadius: 12,
            boxShadow: 'var(--shadow)',
            padding: 14,
            zIndex: 40,
            animation: 'fadeUp .2s ease',
          }}
        >
          <div style={{ font: mono(9, 600), letterSpacing: '.16em', color: 'var(--faint)', marginBottom: 8 }}>
            QUICK RANGES
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 14 }}>
            {QUICK_RANGES.map((q) => {
              const active = value.kind === 'quick' && value.ms === q.ms;
              return (
                <div
                  key={q.label}
                  className="hov-row"
                  onClick={() => {
                    onChange({ kind: 'quick', label: q.label, ms: q.ms });
                    setOpen(false);
                  }}
                  style={{
                    padding: '6px 10px',
                    borderRadius: 7,
                    font: "600 11.5px 'Space Grotesk'",
                    cursor: 'pointer',
                    background: active ? 'var(--accent-dim)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--dim)',
                  }}
                >
                  {q.label}
                </div>
              );
            })}
          </div>
          <div style={{ font: mono(9, 600), letterSpacing: '.16em', color: 'var(--faint)', marginBottom: 8 }}>
            ABSOLUTE RANGE
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(
              [
                ['From', from, setFrom],
                ['To', to, setTo],
              ] as [string, string, (v: string) => void][]
            ).map(([label, val, setter]) => (
              <label key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 38, font: mono(10), color: 'var(--dim)' }}>{label}</span>
                <input
                  type="datetime-local"
                  value={val}
                  onChange={(e) => setter(e.target.value)}
                  style={{
                    flex: 1,
                    background: 'var(--panel2)',
                    border: '1px solid var(--line)',
                    borderRadius: 7,
                    color: 'var(--text)',
                    font: mono(11),
                    padding: '6px 8px',
                    outline: 'none',
                  }}
                />
              </label>
            ))}
            <div
              className="hov-accent"
              onClick={() => {
                const f = new Date(from).getTime();
                const t = new Date(to).getTime();
                if (Number.isFinite(f) && Number.isFinite(t) && f < t) {
                  onChange({ kind: 'absolute', from: f, to: t });
                  setOpen(false);
                }
              }}
              style={{
                background: 'var(--accent)',
                color: 'var(--accent-ink)',
                borderRadius: 8,
                padding: '8px 0',
                font: "600 12px 'Space Grotesk'",
                textAlign: 'center',
                cursor: 'pointer',
                marginTop: 2,
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
