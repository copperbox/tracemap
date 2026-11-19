import { useEffect, useRef } from 'react';
import type { Dispatch, MouseEvent as ReactMouseEvent, MutableRefObject, SetStateAction } from 'react';
import { savePinnedPositions, type NodePositions } from './pinnedPositions';
import type { Transform } from './usePanZoom';

export interface DragItem {
  key: string;
  origX: number;
  origY: number;
}

/**
 * Dragging a node (or a whole team frame) to a pinned position. Deltas are
 * divided by the current zoom so the node tracks the cursor in world space;
 * the pins are persisted once on drop.
 */
export function useNodeDrag(
  tfRef: MutableRefObject<Transform>,
  setPinned: Dispatch<SetStateAction<NodePositions>>,
) {
  const nodeDragRef = useRef<{
    items: DragItem[];
    clientX: number;
    clientY: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    // A mouse can report several moves per frame, and each pinned update
    // re-renders the map: keep the latest position and apply it once a frame.
    let raf = 0;
    let last: { x: number; y: number } | null = null;
    const apply = (): void => {
      raf = 0;
      const nd = nodeDragRef.current;
      const at = last;
      last = null;
      if (!nd || !at) return;
      const dx = (at.x - nd.clientX) / tfRef.current.k;
      const dy = (at.y - nd.clientY) / tfRef.current.k;
      setPinned((prev) => {
        const next = { ...prev };
        for (const it of nd.items) next[it.key] = { x: it.origX + dx, y: it.origY + dy };
        return next;
      });
    };
    const onMove = (e: MouseEvent) => {
      const nd = nodeDragRef.current;
      if (!nd) return;
      if (Math.abs(e.clientX - nd.clientX) + Math.abs(e.clientY - nd.clientY) > 4) nd.moved = true;
      if (!nd.moved) return;
      last = { x: e.clientX, y: e.clientY };
      raf ||= requestAnimationFrame(apply);
    };
    const onUp = () => {
      const nd = nodeDragRef.current;
      if (!nd) return;
      // land on the last reported position before saving
      if (raf) {
        cancelAnimationFrame(raf);
        apply();
      }
      setPinned((prev) => {
        savePinnedPositions(prev);
        return prev;
      });
      // cleared after the click that ends the drag; a drag that already began
      // again in the meantime keeps its own state
      setTimeout(() => {
        if (nodeDragRef.current === nd) nodeDragRef.current = null;
      }, 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [tfRef, setPinned]);

  const beginDrag = (e: ReactMouseEvent, items: DragItem[]) => {
    nodeDragRef.current = { items, clientX: e.clientX, clientY: e.clientY, moved: false };
  };

  /** True while (or just after) a node drag actually moved, so click handlers can ignore it. */
  const wasNodeDrag = () => nodeDragRef.current?.moved ?? false;

  /** Keys being dragged right now, or null. Read during render: every move re-renders via setPinned. */
  const draggedKeys = (): string[] | null => nodeDragRef.current?.items.map((it) => it.key) ?? null;

  return { beginDrag, wasNodeDrag, draggedKeys };
}
