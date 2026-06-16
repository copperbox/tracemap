import styles from './ZoomHint.module.css';

/**
 * Bottom-centre hint shown while the map is zoomed out far enough that node
 * labels are hidden. Tells the user the blank cards are intentional and the map
 * is interactive (scroll/double-click to zoom in), not broken. Non-interactive
 * so it never intercepts pan/zoom on the canvas beneath it.
 */
export function ZoomHint() {
  return (
    <div className={styles.hint} aria-hidden="true">
      <span className={styles.glyph}>+</span>
      Zoom in to read labels
    </div>
  );
}
