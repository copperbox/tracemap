import { memo } from 'react';
import type { Pt } from '../../../lib/edgeGeometry';
import { DOT, fmtErr, fmtMs, fmtRps } from '../../../lib/format';
import { useStore } from '../../../state/store';
import type { EdgeView } from './edgeViews';
import styles from './EdgeLabelLayer.module.css';

/**
 * Whether an edge earns a standing label: selected or unhealthy. The hovered
 * edge gets its label from HoverEdgeLabel, which alone follows the pointer.
 */
export function wantsLabel(v: EdgeView): boolean {
  return !v.dim && (v.isSel || v.e.status !== 'ok');
}

/** Selection and hover show the full triple; an unhealthy edge alone just its p95. */
export function edgeLabelText(v: EdgeView, full = v.isSel): string {
  return full ? `${fmtRps(v.e.rps)}/s ${DOT} ${fmtMs(v.e.p95)} ${DOT} ${fmtErr(v.e.errPct)}` : fmtMs(v.e.p95);
}

function Label({ v, p, full }: { v: EdgeView; p: Pt; full: boolean }) {
  return (
    <div className={styles.anchor} style={{ transform: `translate(${p.x}px, ${p.y}px)` }}>
      <div
        className={[styles.box, v.e.status !== 'ok' ? styles[v.e.status] : '', v.isSel ? styles.selected : '']
          .filter(Boolean)
          .join(' ')}
      >
        {edgeLabelText(v, full)}
      </div>
    </div>
  );
}

/**
 * One standing label. It steps aside while its edge is hovered: the hover
 * label then shows the full triple, placed for that wider text. The selector
 * is a boolean, so a hover re-renders the label it leaves and the one it
 * reaches, not the layer.
 */
const StandingLabel = memo(function StandingLabel({ v, p }: { v: EdgeView; p: Pt }) {
  const hovered = useStore((s) => s.hoverEdge === v.e.key);
  // a selected edge already shows the full label and keeps it
  return hovered && !v.isSel ? null : <Label v={v} p={p} full={v.isSel} />;
});

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
        return p ? <StandingLabel key={`label:${v.e.key}`} v={v} p={p} /> : null;
      })}
    </>
  );
});

/**
 * The hovered edge's label: the full triple, at a spot chosen for its own
 * width, clear of cards and of the standing labels. Apart from the standing
 * label it replaces, it is the only part of the map that follows the hovered
 * edge.
 */
export const HoverEdgeLabel = memo(function HoverEdgeLabel({
  edges,
  spotFor,
}: {
  edges: EdgeView[];
  spotFor: (v: EdgeView) => Pt | undefined;
}) {
  const key = useStore((s) => s.hoverEdge);
  if (!key) return null;
  const v = edges.find((x) => x.e.key === key);
  // a selected edge already shows the full label
  if (!v || v.dim || v.isSel) return null;
  const p = spotFor(v);
  return p ? <Label v={v} p={p} full /> : null;
});
