import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { keyStep, revealScrollTop, sameRange, windowRange, type WindowRange } from './windowing';

/** Where `list` sits inside `scroller`'s scrolled content, px. */
function listTopIn(scroller: HTMLElement, list: HTMLElement): number {
  return list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/**
 * Which rows of a fixed-height list to mount. `scrollRef` is the scrolling
 * element, `listRef` the element whose height is the full list. Re-renders
 * only when the mounted range changes, not on every scroll event.
 */
export function useWindowedRows(
  scrollRef: RefObject<HTMLElement | null>,
  listRef: RefObject<HTMLElement | null>,
  rowHeight: number,
  rowCount: number,
  overscan = 6,
): WindowRange {
  const [range, setRange] = useState<WindowRange>(() =>
    // Before the first measure, assume the list starts in view at the top.
    windowRange({ scrollTop: 0, viewportHeight: 1200, listTop: 0, rowHeight, rowCount, overscan }),
  );

  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    const list = listRef.current;
    if (!scroller || !list) return;
    const next = windowRange({
      scrollTop: scroller.scrollTop,
      viewportHeight: scroller.clientHeight,
      listTop: listTopIn(scroller, list),
      rowHeight,
      rowCount,
      overscan,
    });
    setRange((prev) => (sameRange(prev, next) ? prev : next));
  }, [scrollRef, listRef, rowHeight, rowCount, overscan]);

  useLayoutEffect(() => {
    measure();
    const scroller = scrollRef.current;
    if (!scroller) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [measure, scrollRef]);

  return range;
}

/** Width of an element, tracked with ResizeObserver. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/**
 * Moves keyboard focus to row `index` of a windowed list, scrolling it into
 * view first. A row that is not mounted yet gets focus once the scroll has
 * rendered it. Rows carry `data-row-index` (for the wallboard, the item index).
 */
export function useWindowedFocus(
  scrollRef: RefObject<HTMLElement | null>,
  listRef: RefObject<HTMLElement | null>,
  rowHeight: number,
  coverTop = 0,
): { focusRow: (index: number, rowOfIndex?: number) => void; afterRender: () => void } {
  const pending = useRef<number | null>(null);

  const tryFocus = useCallback(() => {
    const i = pending.current;
    const list = listRef.current;
    if (i == null || !list) return;
    const el = list.querySelector<HTMLElement>(`[data-row-index="${i}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      pending.current = null;
    }
  }, [listRef]);

  const focusRow = useCallback(
    (index: number, rowOfIndex = index) => {
      const scroller = scrollRef.current;
      const list = listRef.current;
      if (!scroller || !list) return;
      const top = revealScrollTop(
        rowOfIndex,
        {
          scrollTop: scroller.scrollTop,
          viewportHeight: scroller.clientHeight,
          listTop: listTopIn(scroller, list),
          rowHeight,
        },
        coverTop,
      );
      if (top != null) scroller.scrollTop = top;
      pending.current = index;
      tryFocus();
    },
    [scrollRef, listRef, rowHeight, coverTop, tryFocus],
  );

  return { focusRow, afterRender: tryFocus };
}

/**
 * Roving focus for a windowed list: the list is one tab stop, arrow keys,
 * Page Up/Down and Home/End move between items, Enter or Space activates one.
 * Items carry `data-row-index`. `rowOf` maps an item to its visual row (grids).
 */
export function useListKeyboard({
  count,
  cols = 1,
  focusRow,
  onActivate,
}: {
  count: number;
  cols?: number;
  focusRow: (index: number, rowOfIndex?: number) => void;
  onActivate: (index: number) => void;
}): {
  activeIndex: number;
  onFocus: (e: FocusEvent<HTMLElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
} {
  const [activeIndex, setActiveIndex] = useState(0);
  const indexOf = (el: EventTarget) => Number((el as HTMLElement).dataset?.rowIndex ?? NaN);

  const onFocus = (e: FocusEvent<HTMLElement>) => {
    const i = indexOf(e.target);
    if (Number.isInteger(i)) setActiveIndex(i);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const i = indexOf(e.target);
    if (!Number.isInteger(i)) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onActivate(i);
      return;
    }
    const next = keyStep(e.key, i, count, cols);
    if (next == null) return;
    e.preventDefault();
    setActiveIndex(next);
    focusRow(next, Math.floor(next / cols));
  };

  return { activeIndex: Math.min(activeIndex, Math.max(0, count - 1)), onFocus, onKeyDown };
}
