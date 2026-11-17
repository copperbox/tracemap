/**
 * Level of detail for the layered map. Below CARD_MIN_K card text is too
 * small to read, so the whole map (nodes, edges, frames) draws on one canvas
 * and no cards are mounted. At or above it, DOM cards mount for the nodes in
 * the padded viewport. The two thresholds form a hysteresis band so a zoom
 * resting on the boundary does not flip back and forth.
 */

export type MapLod = 'canvas' | 'cards';

/** Zoom at or above which DOM cards mount (zooming in). */
export const CARD_MIN_K = 0.5;
/** Zoom below which cards unmount again (zooming out). */
export const CARD_EXIT_K = 0.45;
/**
 * A graph this small mounts cards at every zoom, as the map always did: a
 * few hundred DOM nodes cost nothing and keep small fleets unchanged.
 */
export const SMALL_GRAPH_NODES = 150;

export function chooseLod(k: number, nodeCount: number, prev: MapLod): MapLod {
  if (nodeCount <= SMALL_GRAPH_NODES) return 'cards';
  if (prev === 'cards') return k < CARD_EXIT_K ? 'canvas' : 'cards';
  return k >= CARD_MIN_K ? 'cards' : 'canvas';
}

/**
 * Whether mounted cards hide their text: zoomed below the label threshold,
 * except while isolated (isolation is the "make this tree legible" mode).
 */
export function cardsCompact(k: number, labelMinK: number, isolated: boolean): boolean {
  return !isolated && k < labelMinK;
}

/**
 * Smallest screen font the canvas bothers to draw. Text below this is a smear
 * that costs a fillText per node and reads as noise.
 */
export const CANVAS_MIN_FONT_PX = 3.5;

/** Whether the canvas draws node names at zoom `k` (base font size in world px). */
export function canvasLabelsOn(k: number, labelMinK: number, isolated: boolean, fontPx = 13.5): boolean {
  return (isolated || k >= labelMinK) && fontPx * k >= CANVAS_MIN_FONT_PX;
}
