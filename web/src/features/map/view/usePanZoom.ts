import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { centerTransform, fitZoom } from './camera';

export interface Transform {
  tx: number;
  ty: number;
  k: number;
}

export interface ViewBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Viewport state for the map canvas: wheel zoom, drag-to-pan, button zoom,
 * and fit-to-bounds. Node dragging lives in useNodeDrag; the two never run at
 * once because node mousedown handlers stop propagation before beginPan.
 */
export function usePanZoom(canvasRef: RefObject<HTMLDivElement>) {
  const [tf, setTf] = useState<Transform>({ tx: 60, ty: 40, k: 0.5 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const tfRef = useRef(tf);
  tfRef.current = tf;

  // Wheel zoom (non-passive listener so preventDefault works).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setTf((s) => {
        const k2 = Math.max(0.12, Math.min(2.4, s.k * Math.exp(-e.deltaY * 0.0014)));
        return { k: k2, tx: mx - ((mx - s.tx) * k2) / s.k, ty: my - ((my - s.ty) * k2) / s.k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [canvasRef]);

  // Drag to pan the canvas.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (d.moved) setTf((s) => ({ ...s, tx: d.tx + dx, ty: d.ty + dy }));
    };
    const onUp = () => {
      if (!dragRef.current) return;
      setDragging(false);
      setTimeout(() => {
        dragRef.current = null;
      }, 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const beginPan = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, tx: tfRef.current.tx, ty: tfRef.current.ty, moved: false };
    setDragging(true);
  };

  /** True while (or just after) a pan drag actually moved, so click handlers can ignore it. */
  const wasPan = () => dragRef.current?.moved ?? false;

  const zoomBy = (f: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mx = r.width / 2;
    const my = r.height / 2;
    setTf((s) => {
      const k2 = Math.max(0.12, Math.min(2.4, s.k * f));
      return { k: k2, tx: mx - ((mx - s.tx) * k2) / s.k, ty: my - ((my - s.ty) * k2) / s.k };
    });
  };

  /** Center the given world-space bounds in the canvas at a comfortable zoom. */
  const fitBounds = useCallback(
    (bbox: ViewBounds) => {
      const el = canvasRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const bw = bbox.x1 - bbox.x0;
      const bh = bbox.y1 - bbox.y0;
      const k = fitZoom(bbox, r.width, r.height);
      setTf({
        tx: (r.width - bw * k) / 2 - bbox.x0 * k,
        ty: (r.height - bh * k) / 2 - bbox.y0 * k + 12,
        k,
      });
    },
    [canvasRef],
  );

  /**
   * Pan (and zoom in, never out) so the given world bounds sit centered in the
   * canvas at a legible zoom. Used to bring a freshly selected node into view.
   * `rightInset` keeps the target clear of the open drawer.
   */
  const centerOn = useCallback(
    (bbox: ViewBounds, opts: { rightInset?: number } = {}) => {
      const el = canvasRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setTf((s) => centerTransform(bbox, r.width, r.height, s.k, { rightInset: opts.rightInset }));
    },
    [canvasRef],
  );

  return { tf, tfRef, dragging, beginPan, wasPan, zoomBy, fitBounds, centerOn };
}
