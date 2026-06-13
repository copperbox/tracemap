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
    const onMove = (e: MouseEvent) => {
      const nd = nodeDragRef.current;
      if (!nd) return;
      const dx = (e.clientX - nd.clientX) / tfRef.current.k;
      const dy = (e.clientY - nd.clientY) / tfRef.current.k;
      if (Math.abs(e.clientX - nd.clientX) + Math.abs(e.clientY - nd.clientY) > 4) nd.moved = true;
      if (nd.moved) {
        setPinned((prev) => {
          const next = { ...prev };
          for (const it of nd.items) next[it.key] = { x: it.origX + dx, y: it.origY + dy };
          return next;
        });
      }
    };
    const onUp = () => {
      if (!nodeDragRef.current) return;
      setPinned((prev) => {
        savePinnedPositions(prev);
        return prev;
      });
      setTimeout(() => {
        nodeDragRef.current = null;
      }, 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [tfRef, setPinned]);

  const beginDrag = (e: ReactMouseEvent, items: DragItem[]) => {
    nodeDragRef.current = { items, clientX: e.clientX, clientY: e.clientY, moved: false };
  };

  /** True while (or just after) a node drag actually moved, so click handlers can ignore it. */
  const wasNodeDrag = () => nodeDragRef.current?.moved ?? false;

  return { beginDrag, wasNodeDrag };
}
