import { DOT, fmtErr, fmtMs, fmtRps } from '../../../lib/format';
import type { EdgeView } from './edgeViews';
import styles from './EdgeLabelLayer.module.css';

/**
 * Metric labels pinned to the midpoint of edges that earn attention:
 * selected, hovered, or unhealthy. Selection/hover shows the full triple;
 * an unhealthy edge alone shows just its p95.
 */
export function EdgeLabelLayer({ edges }: { edges: EdgeView[] }) {
  return (
    <>
      {edges
        .filter((v) => !v.dim && (v.isSel || v.isHov || v.e.status !== 'ok'))
        .map((v) => {
          const full = v.isSel || v.isHov;
          return (
            <div
              key={`label:${v.e.key}`}
              className={styles.anchor}
              style={{ transform: `translate(${v.mid.x}px, ${v.mid.y}px)` }}
            >
              <div
                className={[
                  styles.box,
                  v.e.status !== 'ok' ? styles[v.e.status] : '',
                  v.isSel ? styles.selected : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {full
                  ? `${fmtRps(v.e.rps)}/s ${DOT} ${fmtMs(v.e.p95)} ${DOT} ${fmtErr(v.e.errPct)}`
                  : fmtMs(v.e.p95)}
              </div>
            </div>
          );
        })}
    </>
  );
}
