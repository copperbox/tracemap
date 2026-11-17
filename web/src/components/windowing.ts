/**
 * Row windowing math for long lists (services table, wallboard). Only rows
 * near the viewport mount; the list keeps its full scroll height so the
 * scrollbar and scroll position behave as if every row were there.
 */

export interface WindowInput {
  /** scrollTop of the scrolling element. */
  scrollTop: number;
  /** clientHeight of the scrolling element. */
  viewportHeight: number;
  /** Top of the list inside the scrolling element's content, px. */
  listTop: number;
  rowHeight: number;
  rowCount: number;
  /** Extra rows mounted above and below the visible ones. */
  overscan: number;
}

export interface WindowRange {
  /** First mounted row. */
  start: number;
  /** One past the last mounted row. */
  end: number;
  /** Offset of row `start` from the list top, px. */
  offset: number;
  /** Height of the whole list, px. */
  totalHeight: number;
}

export function windowRange(w: WindowInput): WindowRange {
  const totalHeight = Math.max(0, w.rowCount) * w.rowHeight;
  if (w.rowCount <= 0 || w.rowHeight <= 0) return { start: 0, end: 0, offset: 0, totalHeight: 0 };
  const top = w.scrollTop - w.listTop;
  const bottom = top + Math.max(0, w.viewportHeight);
  const clamp = (i: number) => Math.min(w.rowCount, Math.max(0, i));
  const start = clamp(Math.floor(top / w.rowHeight) - w.overscan);
  const end = Math.max(start, clamp(Math.ceil(bottom / w.rowHeight) + w.overscan));
  return { start, end, offset: start * w.rowHeight, totalHeight };
}

export function sameRange(a: WindowRange, b: WindowRange): boolean {
  return a.start === b.start && a.end === b.end && a.totalHeight === b.totalHeight;
}

/** Columns of a CSS `repeat(auto-fill, minmax(minCol, 1fr))` grid at this width. */
export function gridColumns(width: number, minCol: number, gap: number): number {
  if (width <= 0) return 1;
  return Math.max(1, Math.floor((width + gap) / (minCol + gap)));
}

/**
 * The scrollTop that brings row `index` fully into view, or null when it
 * already is. Used to keep keyboard focus on a row that may not be mounted.
 */
export function revealScrollTop(
  index: number,
  w: Pick<WindowInput, 'scrollTop' | 'viewportHeight' | 'listTop' | 'rowHeight'>,
  /** Space covered at the top of the viewport (a sticky header), px. */
  coverTop = 0,
): number | null {
  const rowTop = w.listTop + index * w.rowHeight;
  const rowBottom = rowTop + w.rowHeight;
  if (rowTop < w.scrollTop + coverTop) return Math.max(0, rowTop - coverTop);
  if (rowBottom > w.scrollTop + w.viewportHeight) return rowBottom - w.viewportHeight;
  return null;
}

/** Next index for a list key press, or null for keys the list does not handle. */
export function keyStep(key: string, index: number, count: number, cols = 1, page = 10): number | null {
  if (count <= 0) return null;
  const to = (i: number) => Math.min(count - 1, Math.max(0, i));
  switch (key) {
    case 'ArrowDown':
      return to(index + cols);
    case 'ArrowUp':
      return to(index - cols);
    case 'ArrowRight':
      return cols > 1 ? to(index + 1) : null;
    case 'ArrowLeft':
      return cols > 1 ? to(index - 1) : null;
    case 'PageDown':
      return to(index + page * cols);
    case 'PageUp':
      return to(index - page * cols);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * The item a key press on a windowed list acts on: the focused row, or, when
 * focus sits on the list itself (its row scrolled away and unmounted), the
 * last active item.
 */
export function keyTargetIndex(rowIndex: number | null, onList: boolean, activeIndex: number): number | null {
  if (rowIndex != null && Number.isInteger(rowIndex)) return rowIndex;
  return onList ? activeIndex : null;
}

/**
 * Whether the list should take focus back after a render: it held focus, and
 * focus now rests nowhere (the focused row unmounted, which leaves focus on
 * the body). Focus the user moved elsewhere is left alone.
 */
export function shouldReclaimFocus(
  listHadFocus: boolean,
  active: { isConnected: boolean } | null,
  body: unknown,
): boolean {
  return listHadFocus && (active == null || active === body || !active.isConnected);
}
