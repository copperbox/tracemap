import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { packetCount, packetSeed, packetTravelMs } from '../../../lib/flow';
import { useStore } from '../../../state/store';
import type { EdgeView } from './edgeViews';
import { packetSamples } from './packetAnim';
import { buildArcLut, pointAtFraction, type ArcLut } from './packetPath';
import type { Transform } from './usePanZoom';
import styles from './PacketCanvas.module.css';

/**
 * Glowing packets traveling each live edge, rendered as cheap sprite blits on a
 * SINGLE screen-space canvas with one rAF loop -- replacing the old approach of
 * one DOM element (and one GPU layer) per packet, which exploded the layer
 * count on large graphs and pinned the GPU.
 *
 * Why screen-space (not inside the transformed world): a canvas only needs the
 * viewport's worth of pixels and stays crisp at any zoom, and world->screen
 * culling is then trivial -- only on-screen packets cost anything. Positions
 * come from each edge's cubic control points (no SVG-path readback), advanced
 * by elapsed time so packet density tracks the measured rps.
 */

// Visual tuning. Packet glow is baked into a sprite ONCE (never per-frame
// shadowBlur), so drawing a packet is a single textured blit.
const SPRITE_PX = 128;
const DOT_BASE = 4; // packet core diameter in world px (scales with zoom)
const DOT_MIN = 2.5;
const DOT_MAX = 8;
const GLOW_SCALE = 2; // full sprite span as a multiple of the core diameter
const PACKET_ALPHA = 0.62; // global opacity damp so packets stay unobtrusive

/** The three flow colors (EdgeView.flowStroke) mapped to their CSS variable. */
const VAR_OF: Record<string, string> = {
  'var(--accent)': '--accent',
  'var(--warn)': '--warn',
  'var(--crit)': '--crit',
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Pre-render one glowing dot for a color into an offscreen canvas. */
function makeSprite(color: string): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = SPRITE_PX;
  cv.height = SPRITE_PX;
  const ctx = cv.getContext('2d');
  if (!ctx) return cv;
  const c = SPRITE_PX / 2;
  const rgb = hexToRgb(color);
  if (!rgb) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(c, c, c * 0.42, 0, Math.PI * 2);
    ctx.fill();
    return cv;
  }
  const rgba = (a: number): string => `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  // tight core with a quick falloff -> a small defined dot, not a wide halo
  grad.addColorStop(0, rgba(0.9));
  grad.addColorStop(0.34, rgba(0.78));
  grad.addColorStop(0.52, rgba(0.2));
  grad.addColorStop(1, rgba(0));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
  return cv;
}

function buildSprites(): Record<string, HTMLCanvasElement> {
  const out: Record<string, HTMLCanvasElement> = {};
  const cs = getComputedStyle(document.body);
  for (const [varStr, name] of Object.entries(VAR_OF)) {
    out[varStr] = makeSprite(cs.getPropertyValue(name).trim());
  }
  return out;
}

export function PacketCanvas({ edges, tfRef }: { edges: EdgeView[]; tfRef: RefObject<Transform> }) {
  const theme = useStore((s) => s.theme);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const sizeRef = useRef({ cssW: 0, cssH: 0 });
  const spritesRef = useRef<Record<string, HTMLCanvasElement>>({});
  // arc-length tables cached per edge, rebuilt only when the edge's path changes
  const lutRef = useRef<Map<string, { d: string; lut: ArcLut }>>(new Map());
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  // The loop only runs while at least one edge is actually carrying traffic, so
  // an idle (or fully dimmed/filtered) graph costs nothing.
  const hasLive = useMemo(
    () => edges.some((v) => v.flowOp > 0 && v.e.rps > 0 && !v.e.stale),
    [edges],
  );

  // Canvas context + size tracking (device-pixel-ratio aware so packets are crisp).
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    ctxRef.current = cv.getContext('2d');
    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = cv.clientWidth;
      const cssH = cv.clientHeight;
      cv.width = Math.max(1, Math.round(cssW * dpr));
      cv.height = Math.max(1, Math.round(cssH * dpr));
      ctxRef.current?.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { cssW, cssH };
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    return () => ro.disconnect();
  }, []);

  // Rebuild glow sprites for the active theme (colors come from CSS variables).
  useEffect(() => {
    spritesRef.current = buildSprites();
  }, [theme]);

  const drawFrame = useCallback(
    (now: number): void => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      const { cssW, cssH } = sizeRef.current;
      ctx.clearRect(0, 0, cssW, cssH);
      const tf = tfRef.current;
      if (!tf) return;

      const edgeList = edgesRef.current;
      const sprites = spritesRef.current;
      const cache = lutRef.current;
      if (cache.size > edgeList.length * 4 + 8) cache.clear(); // drop entries from removed edges

      const k = tf.k;
      const dia = Math.max(DOT_MIN, Math.min(DOT_MAX, DOT_BASE * k));
      const size = dia * GLOW_SCALE;
      const half = size / 2;

      for (const v of edgeList) {
        if (v.flowOp <= 0) continue;
        const e = v.e;
        if (!(e.rps > 0) || e.stale) continue;
        const count = packetCount(e.rps);
        if (!count) continue;
        const sprite = sprites[v.flowStroke];
        if (!sprite) continue;

        let hit = cache.get(e.key);
        if (!hit || hit.d !== v.d) {
          hit = { d: v.d, lut: buildArcLut(v.curve) };
          cache.set(e.key, hit);
        }
        const lut = hit.lut;
        const travelMs = packetTravelMs(lut.length);
        for (const s of packetSamples(count, travelMs, now, packetSeed(e.key))) {
          const op = s.opacity * v.flowOp * PACKET_ALPHA;
          if (op <= 0.012) continue;
          const pt = pointAtFraction(lut, s.s);
          const sx = tf.tx + pt.x * k;
          const sy = tf.ty + pt.y * k;
          if (sx < -half || sx > cssW + half || sy < -half || sy > cssH + half) continue;
          ctx.globalAlpha = op;
          ctx.drawImage(sprite, sx - half, sy - half, size, size);
        }
      }
      ctx.globalAlpha = 1;
    },
    [tfRef],
  );

  useEffect(() => {
    const clear = (): void => {
      const { cssW, cssH } = sizeRef.current;
      ctxRef.current?.clearRect(0, 0, cssW, cssH);
    };
    if (!hasLive) {
      clear();
      return;
    }
    let raf = 0;
    const loop = (now: number): void => {
      drawFrame(now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      clear();
    };
  }, [hasLive, drawFrame]);

  return <canvas ref={canvasRef} className={styles.layer} />;
}
