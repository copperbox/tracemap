import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { filterOptions, type ComboOption } from '../lib/combobox';
import styles from './Combobox.module.css';

/**
 * Searchable single-select dropdown shared across the app (the team filter on
 * the map + services list, and the duplicate-service picker in the edit modal).
 * Type to narrow the options; arrow keys + enter to choose; escape or an
 * outside click dismisses. The selected value is owned by the parent so each
 * call site renders the consequence however it likes.
 *
 * `block`   stretches the trigger to fill a form row (rectangular) instead of
 *           the inline pill used on the canvas.
 * `dropUp`  opens the popover above the trigger -- needed inside scroll
 *           containers (e.g. the modal body) where a downward menu is clipped.
 */
export function Combobox<V>({
  options,
  value,
  onChange,
  label,
  placeholder = 'Filter...',
  emptyText = 'no matches',
  active = false,
  block = false,
  dropUp = false,
  icon,
}: {
  options: ComboOption<V>[];
  value: V;
  onChange: (v: V) => void;
  label: string;
  placeholder?: string;
  emptyText?: string;
  active?: boolean;
  block?: boolean;
  dropUp?: boolean;
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => filterOptions(options, query), [options, query]);

  // Close on an outside click (mousedown so it also wins over a canvas pan).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Focus the search box when opening; keep the highlight valid as typing
  // shrinks the option list.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => setHi(0), [query]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const pick = (v: V) => {
    onChange(v);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHi((h) => Math.min(h + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = shown[hi];
      if (opt) pick(opt.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  return (
    <div
      ref={ref}
      className={`${styles.wrap} ${block ? styles.block : ''}`}
      // Stop a map canvas from treating dropdown interaction as a pan/clear.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className={`${styles.trigger} ${active ? styles.triggerActive : ''} hov-btn`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {icon}
        <span className={styles.label}>{label}</span>
        <svg className={styles.chev} width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {open && (
        <div className={`${styles.popover} ${dropUp ? styles.dropUp : ''}`} onClick={(e) => e.stopPropagation()}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className={styles.search}
          />
          <div className={styles.list}>
            {shown.map((o, i) => (
              <div
                key={String(o.value)}
                className={`${styles.option} ${i === hi ? styles.optionHi : ''} ${
                  o.value === value ? styles.optionActive : ''
                }`}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(o.value)}
              >
                {o.label}
              </div>
            ))}
            {!shown.length && <div className={styles.noOpt}>{emptyText}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
