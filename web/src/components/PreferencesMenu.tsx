import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import type { LabelZoomLevel, Theme } from '../lib/preferences';
import { SettingsIcon, ThemeIcon } from './Icon';
import styles from './PreferencesMenu.module.css';

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

const LABEL_ZOOM_OPTIONS: { value: LabelZoomLevel; label: string }[] = [
  { value: 'always', label: 'Always' },
  { value: 'far', label: 'Zoomed out' },
  { value: 'default', label: 'Default' },
  { value: 'close', label: 'Zoomed in' },
];

/**
 * The header preferences cog: opens a popover with the persisted user
 * preferences (theme, map label zoom threshold).
 */
export function PreferencesMenu() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const labelZoom = useStore((s) => s.labelZoom);
  const setLabelZoom = useStore((s) => s.setLabelZoom);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Dismiss on Escape or a click outside the cog + panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={`${styles.cogBtn} ${open ? styles.cogBtnOpen : ''} hov-btn`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Preferences"
        title="Preferences"
      >
        <SettingsIcon />
      </button>
      {open && (
        <div className={styles.panel} role="dialog" aria-label="Preferences">
          <div className={styles.head}>Preferences</div>

          <div className={styles.row}>
            <div className={styles.rowLabel}>Theme</div>
            <div className={styles.segment} role="radiogroup" aria-label="Theme">
              {THEME_OPTIONS.map((opt) => (
                <button
                  type="button"
                  key={opt.value}
                  role="radio"
                  aria-checked={theme === opt.value}
                  className={
                    theme === opt.value ? `${styles.segBtn} ${styles.segBtnActive}` : styles.segBtn
                  }
                  onClick={() => setTheme(opt.value)}
                >
                  <ThemeIcon theme={opt.value} />
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.rowLabel}>Map labels</div>
            <div className={styles.segment} role="radiogroup" aria-label="Map labels">
              {LABEL_ZOOM_OPTIONS.map((opt) => (
                <button
                  type="button"
                  key={opt.value}
                  role="radio"
                  aria-checked={labelZoom === opt.value}
                  className={
                    labelZoom === opt.value
                      ? `${styles.segBtn} ${styles.segBtnActive}`
                      : styles.segBtn
                  }
                  onClick={() => setLabelZoom(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className={styles.hint}>How far you must zoom in before node labels show</div>
          </div>
        </div>
      )}
    </div>
  );
}
