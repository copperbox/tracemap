/**
 * localStorage persistence for app-wide user preferences (theme, label zoom,
 * team grouping).
 * Loaded once when the store initializes; saved on every preference change.
 */

export type Theme = 'dark' | 'light';

/**
 * When map labels appear while zooming, as a multiplier on each view's default
 * label threshold: 'always' never hides labels, 'far' shows them earlier
 * (zoomed further out), 'default' keeps the tuned threshold, 'close' requires
 * zooming further in.
 */
export type LabelZoomLevel = 'always' | 'far' | 'default' | 'close';

export const LABEL_ZOOM_FACTOR: Record<LabelZoomLevel, number> = {
  always: 0,
  far: 0.6,
  default: 1,
  close: 1.4,
};

export interface Prefs {
  theme: Theme;
  labelZoom: LabelZoomLevel;
  /**
   * Whether the map wraps each team's services in a merge-able ownership
   * container. When off, services stay individual and each carries its owning
   * team as a subtitle instead.
   */
  teamGrouping: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'dark',
  labelZoom: 'default',
  teamGrouping: true,
};

const PREFS_KEY = 'tracemap.prefs';

const THEMES: readonly Theme[] = ['dark', 'light'];
const LABEL_ZOOM_LEVELS: readonly LabelZoomLevel[] = ['always', 'far', 'default', 'close'];

/**
 * Read persisted preferences, falling back to defaults field-by-field so a
 * corrupt or stale entry (e.g. a removed enum value) never breaks startup.
 */
export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return {
      theme: THEMES.includes(raw.theme as Theme) ? (raw.theme as Theme) : DEFAULT_PREFS.theme,
      labelZoom: LABEL_ZOOM_LEVELS.includes(raw.labelZoom as LabelZoomLevel)
        ? (raw.labelZoom as LabelZoomLevel)
        : DEFAULT_PREFS.labelZoom,
      teamGrouping:
        typeof raw.teamGrouping === 'boolean' ? raw.teamGrouping : DEFAULT_PREFS.teamGrouping,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable (private mode, quota): preferences just don't persist.
  }
}
