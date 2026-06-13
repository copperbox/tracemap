import { FitIcon, ResetLayoutIcon } from '../../../components/Icon';
import styles from './ZoomControls.module.css';

/** Zoom stack in the bottom-right corner; shifts left while the drawer is open. */
export function ZoomControls({
  shifted,
  onZoomIn,
  onZoomOut,
  onFit,
  onResetLayout,
}: {
  /** True while the selection drawer is open. */
  shifted: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onResetLayout: () => void;
}) {
  return (
    <div className={`${styles.stack} ${shifted ? styles.shifted : ''}`}>
      {(
        [
          ['+', onZoomIn],
          ['\u2212', onZoomOut],
        ] as const
      ).map(([label, fn]) => (
        <div
          key={label}
          className={`${styles.btn} ${styles.zoomGlyph} hov-btn`}
          onClick={(e) => {
            e.stopPropagation();
            fn();
          }}
        >
          {label}
        </div>
      ))}
      <div
        className={`${styles.btn} hov-btn`}
        title="Fit to view"
        onClick={(e) => {
          e.stopPropagation();
          onFit();
        }}
      >
        <FitIcon />
      </div>
      <div
        className={`${styles.btn} hov-btn`}
        title="Reset layout to default (clears dragged node positions)"
        onClick={(e) => {
          e.stopPropagation();
          onResetLayout();
        }}
      >
        <ResetLayoutIcon />
      </div>
    </div>
  );
}
