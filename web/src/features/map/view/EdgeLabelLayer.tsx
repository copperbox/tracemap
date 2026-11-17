import { memo } from 'react';
import type { Pt } from '../../../lib/edgeGeometry';
import { DOT, fmtErr, fmtMs, fmtRps } from '../../../lib/format';
import type { EdgeView } from './edgeViews';
import styles from './EdgeLabelLayer.module.css';

/** Whether an edge earns a label: selected, hovered, or unhealthy. */
export function wantsLabel(v: EdgeView): boolean {
  return !v.dim && (v.isSel || v.isHov || v.e.status !== 'ok');
}

/** Selection/hover shows the full triple; an unhealthy edge alone just its p95. */
export function edgeLabelText(v: EdgeView): string {
  return v.isSel || v.isHov
    ? `${fmtRps(v.e.rps)}/s ${DOT} ${fmtMs(v.e.p95)} ${DOT} ${fmtErr(v.e.errPct)}`
    : fmtMs(v.e.p95);
}

/**
 * Metric labels on edges that earn attention, at the spots chosen by
 * placeEdgeLabels (clear of cards). An edge without a spot gets no label.
 */
export const EdgeLabelLayer = memo(function EdgeLabelLayer({
  edges,
  spots,
}: {
  edges: EdgeView[];
  spots: Map<string, Pt>;
}) {
  return (
    <>
      {edges.filter(wantsLabel).map((v) => {
        const p = spots.get(v.e.key);
        if (!p) return null;
        return (
          <div
            key={`label:${v.e.key}`}
            className={styles.anchor}
            style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
          >
            <div
              className={[styles.box, v.e.status !== 'ok' ? styles[v.e.status] : '', v.isSel ? styles.selected : '']
                .filter(Boolean)
                .join(' ')}
            >
              {edgeLabelText(v)}
            </div>
          </div>
        );
      })}
    </>
  );
});
