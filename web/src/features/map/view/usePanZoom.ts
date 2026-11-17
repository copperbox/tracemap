import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, MutableRefObject, RefObject } from 'react';
import { centerTransform, clampZoom, fitZoom } from './camera';

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

export type CameraListener = (tf: Transform) => void;

export interface PanZoom {
  /** Current transform. Read it; change it only through the methods below. */
  tfRef: MutableRefObject<Transform>;
  /** Called synchronously on every camera change; returns an unsubscribe. */
  subscribe: (fn: CameraListener) => () => void;
  /** True while a pan drag is in progress (changes twice per drag). */
  dragging: boolean;
  beginPan: (e: ReactMouseEvent) => void;
  wasPan: () => boolean;
  zoomBy: (f: number) => void;
  /** Zoom by `f` about a screen point (canvas-relative px). */
  zoomAt: (f: number, mx: number, my: number) => void;
  fitBounds: (bbox: ViewBounds) => void;
  centerOn: (bbox: ViewBounds, opts?: { rightInset?: number }) => void;
  /** Move the camera by a screen-pixel offset. */
  panBy: (dx: number, dy: number) => void;
}

/**
 * Viewport camera for the map canvas: wheel zoom, drag-to-pan, button zoom,
 * and fit-to-bounds. The transform lives in a ref, not in React state: every
 * wheel tick and mouse move notifies subscribers, which move the DOM layer
 * and redraw the canvas directly. React only re-renders when a subscriber
 * decides the visible set or level of detail changed.
 *
 * Node dragging lives in useNodeDrag; the two never run at once because node
 * mousedown handlers stop propagation before beginPan.
 */
export function usePanZoom(canvasRef: RefObject<HTMLDivElement>): PanZoom {
  const tfRef = useRef<Transform>({ tx: 60, ty: 40, k: 0.5 });
  const listenersRef = useRef(new Set<CameraListener>());
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);

  const setTf = useCallback((next: Transform) => {
    const cur = tfRef.current;
    if (cur.tx === next.tx && cur.ty === next.ty && cur.k === next.k) return;
    tfRef.current = next;
    for (const fn of listenersRef.current) fn(next);
  }, []);

  const subscribe = useCallback((fn: CameraListener) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const zoomAt = useCallback(
    (f: number, mx: number, my: number) => {
      const s = tfRef.current;
      const k2 = clampZoom(s.k * f);
      setTf({ k: k2, tx: mx - ((mx - s.tx) * k2) / s.k, ty: my - ((my - s.ty) * k2) / s.k });
    },
    [setTf],
  );

  // Wheel zoom (non-passive listener so preventDefault works).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0014), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [canvasRef, zoomAt]);

  // Drag to pan the canvas.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (d.moved) setTf({ k: tfRef.current.k, tx: d.tx + dx, ty: d.ty + dy });
    };
    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      setDragging(false);
      // cleared after the click that ends the drag; a drag that already began
      // again in the meantime keeps its own state
      setTimeout(() => {
        if (dragRef.current === d) dragRef.current = null;
      }, 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [setTf]);

  const beginPan = useCallback((e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, tx: tfRef.current.tx, ty: tfRef.current.ty, moved: false };
    setDragging(true);
  }, []);

  /** True while (or just after) a pan drag actually moved, so click handlers can ignore it. */
  const wasPan = useCallback(() => dragRef.current?.moved ?? false, []);

  const zoomBy = useCallback(
    (f: number) => {
      const el = canvasRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      zoomAt(f, r.width / 2, r.height / 2);
    },
    [canvasRef, zoomAt],
  );

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
    [canvasRef, setTf],
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
      setTf(centerTransform(bbox, r.width, r.height, tfRef.current.k, { rightInset: opts.rightInset }));
    },
    [canvasRef, setTf],
  );

  const panBy = useCallback(
    (dx: number, dy: number) => {
      const s = tfRef.current;
      setTf({ k: s.k, tx: s.tx + dx, ty: s.ty + dy });
    },
    [setTf],
  );

  return { tfRef, subscribe, dragging, beginPan, wasPan, zoomBy, zoomAt, fitBounds, centerOn, panBy };
}

/**
 * Keep the dotted backdrop of `el` in step with the camera without React:
 * tile size, offset and the brightness compensation variable.
 */
export function applyBackdrop(el: HTMLElement, tf: Transform, tile: number, dotK: number): void {
  el.style.backgroundSize = `${tile}px ${tile}px`;
  el.style.backgroundPosition = `${tf.tx}px ${tf.ty}px`;
  el.style.setProperty('--dot-k', String(dotK));
}
