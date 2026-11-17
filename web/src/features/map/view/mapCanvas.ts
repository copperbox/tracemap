import type { GraphNode } from '../../../lib/grouping';
import { GROUP_H, GROUP_W, NODE_H, NODE_W } from '../../../lib/layout';
import type { Pos } from '../../../lib/transition';
import type { EdgeView } from './edgeViews';
import type { FrameView } from './frameViews';
import type { Transform } from './usePanZoom';
import type { WorldRect } from './viewport';

/**
 * Canvas half of the layered map. Frames and edges always draw here; nodes
 * draw here only at the overview level of detail, where DOM cards would be
 * unreadable anyway. Drawing happens in world coordinates under the camera
 * transform, culled to the screen, with edges and small nodes batched into
 * one path per style so a fleet-wide overview is a few dozen draw calls.
 */

export interface MapPalette {
  panel: string;
  line: string;
  frameLine: string;
  frameBg: string;
  text: string;
  dim: string;
  faint: string;
  ok: string;
  warn: string;
  crit: string;
  accent: string;
}

const FALLBACK: MapPalette = {
  panel: '#0d131f',
  line: 'rgba(148, 170, 200, 0.26)',
  frameLine: 'rgba(148, 170, 200, 0.4)',
  frameBg: 'rgba(148, 170, 200, 0.055)',
  text: '#e8eef8',
  dim: '#8b98ac',
  faint: '#5a6678',
  ok: '#34d399',
  warn: '#fbbf24',
  crit: '#f87171',
  accent: '#4ade80',
};

/** Resolve the theme's CSS variables into concrete canvas colors. */
export function readPalette(el: Element = document.body): MapPalette {
  const cs = getComputedStyle(el);
  const v = (name: string, fb: string): string => cs.getPropertyValue(name).trim() || fb;
  return {
    panel: v('--panel', FALLBACK.panel),
    line: v('--line2', FALLBACK.line),
    frameLine: v('--frame-line', FALLBACK.frameLine),
    frameBg: v('--frame-bg', FALLBACK.frameBg),
    text: v('--text', FALLBACK.text),
    dim: v('--dim', FALLBACK.dim),
    faint: v('--faint', FALLBACK.faint),
    ok: v('--ok', FALLBACK.ok),
    warn: v('--warn', FALLBACK.warn),
    crit: v('--crit', FALLBACK.crit),
    accent: v('--accent', FALLBACK.accent),
  };
}

/** EdgeView colors are CSS var references; map them onto the palette. */
function resolveVar(pal: MapPalette, c: string): string {
  if (c === 'var(--crit)') return pal.crit;
  if (c === 'var(--warn)') return pal.warn;
  if (c === 'var(--accent)') return pal.accent;
  return c;
}

export interface CanvasScene {
  /** Draw nodes on the canvas (overview level of detail). */
  drawNodes: boolean;
  /** Draw frame titles on the canvas (no DOM title bars mounted). */
  frameTitles: boolean;
  /** Draw node names (canvas nodes only). */
  labels: boolean;
  nodes: GraphNode[];
  posOf: (key: string) => Pos | undefined;
  dimmed: (key: string) => boolean;
  selKey: string | null;
  hoverKey: string | null;
  frames: FrameView[];
  edges: EdgeView[];
}

const sizeOf = (n: GraphNode): { w: number; h: number } =>
  n.kind === 'group' ? { w: GROUP_W, h: GROUP_H } : { w: NODE_W, h: NODE_H };

/** External and datastore nodes get a dashed border, as the DOM card does. */
const isDashed = (n: GraphNode): boolean =>
  n.isExternal || (n.kind !== 'group' && n.type !== 'service' && n.type !== 'bff' && n.type !== 'gateway');

/** Below this on-screen width a node is a status-colored block, not a card. */
const BLOCK_NODE_PX = 18;
/** Screen size of a team name drawn on the canvas, above its frame. */
export const FRAME_LABEL_PX = 11;
/** Arrowheads are pointless below this zoom (they would be under 2 px). */
const ARROW_MIN_K = 0.22;

/** World rect visible on a `w` x `h` canvas, grown by `margin` screen px. */
function screenWorld(tf: Transform, w: number, h: number, margin: number): WorldRect {
  return {
    x0: (-margin - tf.tx) / tf.k,
    y0: (-margin - tf.ty) / tf.k,
    x1: (w + margin - tf.tx) / tf.k,
    y1: (h + margin - tf.ty) / tf.k,
  };
}

const outside = (v: WorldRect, x0: number, y0: number, x1: number, y1: number): boolean =>
  x1 < v.x0 || x0 > v.x1 || y1 < v.y0 || y0 > v.y1;

function statusColor(pal: MapPalette, status: string): string {
  return status === 'crit' ? pal.crit : status === 'warn' ? pal.warn : pal.ok;
}

export function drawMap(
  ctx: CanvasRenderingContext2D,
  scene: CanvasScene,
  tf: Transform,
  cssW: number,
  cssH: number,
  dpr: number,
  pal: MapPalette,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const k = tf.k;
  if (!(k > 0)) return;
  const view = screenWorld(tf, cssW, cssH, 24);
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tf.tx, dpr * tf.ty);
  const px = 1 / k; // one screen pixel in world units

  // ---- frames ----
  for (const f of scene.frames) {
    if (outside(view, f.x, f.y, f.x + f.w, f.y + f.h)) continue;
    ctx.globalAlpha = f.dim ? 0.13 : 1;
    ctx.beginPath();
    ctx.roundRect(f.x, f.y, f.w, f.h, 14);
    ctx.fillStyle = pal.frameBg;
    ctx.fill();
    ctx.lineWidth = Math.max(1.6, 0.8 * px);
    ctx.strokeStyle = pal.frameLine;
    ctx.stroke();
  }
  if (scene.frameTitles) {
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    for (const f of scene.frames) {
      if (outside(view, f.x, f.y - FRAME_LABEL_PX * px, f.x + f.w, f.y + 40)) continue;
      // Team names stay readable at any zoom: the overview is where a
      // responder finds their way, so the name is never scaled below 10 px.
      // It sits just above the frame, clear of the member nodes.
      const fontPx = FRAME_LABEL_PX;
      if (f.w * k < fontPx * 3) continue;
      ctx.font = `700 ${fontPx * px}px "Space Grotesk", system-ui, sans-serif`;
      // a name that does not fit its frame would run into the neighbor's
      if (ctx.measureText(f.name).width > f.w - 20 * px) continue;
      ctx.globalAlpha = f.dim ? 0.13 : 1;
      ctx.fillStyle = pal.text;
      ctx.fillText(f.name, f.x + 4 * px, f.y - 4 * px);
    }
  }
  ctx.globalAlpha = 1;

  // ---- edges, batched per style ----
  const buckets = new Map<string, EdgeView[]>();
  let selected: EdgeView | null = null;
  for (const v of scene.edges) {
    const c = v.curve;
    const x0 = Math.min(c.a.x, c.b.x, c.c1.x, c.c2.x);
    const x1 = Math.max(c.a.x, c.b.x, c.c1.x, c.c2.x);
    const y0 = Math.min(c.a.y, c.b.y, c.c1.y, c.c2.y);
    const y1 = Math.max(c.a.y, c.b.y, c.c1.y, c.c2.y);
    if (outside(view, x0, y0, x1, y1)) continue;
    if (v.glow) selected = v;
    const key = `${v.stroke}|${v.op.toFixed(2)}|${v.w}|${v.arrowOp.toFixed(2)}`;
    const arr = buckets.get(key);
    if (arr) arr.push(v);
    else buckets.set(key, [v]);
  }
  ctx.lineCap = 'round';
  for (const list of buckets.values()) {
    const v0 = list[0];
    const color = resolveVar(pal, v0.stroke);
    ctx.globalAlpha = v0.op;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(v0.w, 0.6 * px);
    const glow = v0.glow && list.length === 1;
    if (glow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 6 * dpr;
    }
    ctx.beginPath();
    for (const v of list) {
      const c = v.curve;
      ctx.moveTo(c.a.x, c.a.y);
      ctx.bezierCurveTo(c.c1.x, c.c1.y, c.c2.x, c.c2.y, c.b.x, c.b.y);
    }
    ctx.stroke();
    if (glow) ctx.shadowBlur = 0;
    if (k >= ARROW_MIN_K) {
      ctx.globalAlpha = v0.arrowOp;
      ctx.fillStyle = resolveVar(pal, v0.arrowFill);
      ctx.beginPath();
      for (const v of list) {
        const [a, b, c] = v.arrowPts;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
        ctx.closePath();
      }
      ctx.fill();
    }
  }
  // the selected edge again on top, with its glow, so a crowd cannot hide it
  if (selected) {
    const c = selected.curve;
    const color = resolveVar(pal, selected.stroke);
    ctx.globalAlpha = selected.op;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(selected.w, 1.6 * px);
    ctx.shadowColor = color;
    ctx.shadowBlur = 6 * dpr;
    ctx.beginPath();
    ctx.moveTo(c.a.x, c.a.y);
    ctx.bezierCurveTo(c.c1.x, c.c1.y, c.c2.x, c.c2.y, c.b.x, c.b.y);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;

  if (!scene.drawNodes) return;

  // ---- nodes ----
  const blocks = new Map<string, { x: number; y: number; w: number; h: number }[]>();
  const cards: { n: GraphNode; x: number; y: number; w: number; h: number; dim: boolean }[] = [];
  const top: { n: GraphNode; x: number; y: number; w: number; h: number; dim: boolean }[] = [];
  for (const n of scene.nodes) {
    const p = scene.posOf(n.key);
    if (!p) continue;
    const { w, h } = sizeOf(n);
    if (outside(view, p.x, p.y, p.x + w, p.y + h)) continue;
    const dim = scene.dimmed(n.key);
    const item = { n, x: p.x, y: p.y, w, h, dim };
    if (n.key === scene.selKey || n.key === scene.hoverKey) {
      top.push(item);
    } else if (w * k < BLOCK_NODE_PX) {
      const color =
        n.status === 'ok' ? (n.kind === 'group' ? pal.dim : pal.faint) : statusColor(pal, n.status);
      const key = `${color}|${dim ? 1 : 0}`;
      const arr = blocks.get(key);
      if (arr) arr.push(item);
      else blocks.set(key, [item]);
    } else {
      cards.push(item);
    }
  }
  for (const [key, list] of blocks) {
    const [color, dim] = key.split('|');
    ctx.globalAlpha = dim === '1' ? 0.13 : 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const r of list) ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const drawCard = (it: (typeof cards)[number], sel: boolean, hover: boolean): void => {
    const { n, x, y, w, h } = it;
    const alpha = it.dim ? 0.13 : 1;
    const sc = statusColor(pal, n.status);
    ctx.globalAlpha = alpha;
    if (w * k < BLOCK_NODE_PX) {
      ctx.fillStyle = n.status === 'ok' ? pal.faint : sc;
      ctx.fillRect(x, y, w, h);
    } else {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 11);
      ctx.fillStyle = pal.panel;
      ctx.fill();
      ctx.lineWidth = Math.max(n.kind === 'group' ? 1.4 : 1.2, px);
      ctx.strokeStyle = n.status === 'ok' ? pal.line : sc;
      const dashed = isDashed(n);
      if (dashed) ctx.setLineDash([5, 4]);
      ctx.stroke();
      if (dashed) ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x + w - 15, y + 15, 4, 0, Math.PI * 2);
      ctx.fillStyle = sc;
      ctx.fill();
      if (scene.labels || sel || hover) {
        ctx.fillStyle = pal.text;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.font = `600 ${n.kind === 'group' ? 15 : 13.5}px "Space Grotesk", system-ui, sans-serif`;
        ctx.fillText(n.label, x + 12, y + h / 2, w - 24);
      }
    }
    if (sel || hover) {
      ctx.globalAlpha = it.dim ? 0.3 : 1;
      ctx.beginPath();
      const o = (sel ? 4 : 2.5) * px;
      ctx.roundRect(x - o, y - o, w + 2 * o, h + 2 * o, 11 + o);
      ctx.lineWidth = (sel ? 2.5 : 1.5) * px;
      ctx.strokeStyle = sel ? (n.status === 'ok' ? pal.accent : sc) : pal.accent;
      ctx.stroke();
    }
  };
  // Mid-zoom cards, batched: one fill for every panel, then one stroke, dot
  // and label pass per style. Each card alone would be four draw calls.
  type Card = (typeof cards)[number];
  const group = <K extends string>(list: Card[], keyOf: (c: Card) => K): Map<K, Card[]> => {
    const m = new Map<K, Card[]>();
    for (const c of list) {
      const key = keyOf(c);
      const arr = m.get(key);
      if (arr) arr.push(c);
      else m.set(key, [c]);
    }
    return m;
  };
  for (const [dim, list] of group(cards, (c) => (c.dim ? '1' : '0'))) {
    ctx.globalAlpha = dim === '1' ? 0.13 : 1;
    ctx.fillStyle = pal.panel;
    ctx.beginPath();
    for (const c of list) ctx.roundRect(c.x, c.y, c.w, c.h, 11);
    ctx.fill();
  }
  for (const [key, list] of group(cards, (c) => `${c.n.status}|${c.dim ? 1 : 0}|${isDashed(c.n) ? 1 : 0}`)) {
    const [status, dim, dashed] = key.split('|');
    ctx.globalAlpha = dim === '1' ? 0.13 : 1;
    ctx.strokeStyle = status === 'ok' ? pal.line : statusColor(pal, status);
    ctx.lineWidth = Math.max(1.2, px);
    if (dashed === '1') ctx.setLineDash([5, 4]);
    ctx.beginPath();
    for (const c of list) ctx.roundRect(c.x, c.y, c.w, c.h, 11);
    ctx.stroke();
    if (dashed === '1') ctx.setLineDash([]);
  }
  for (const [key, list] of group(cards, (c) => `${c.n.status}|${c.dim ? 1 : 0}`)) {
    const [status, dim] = key.split('|');
    ctx.globalAlpha = dim === '1' ? 0.13 : 1;
    ctx.fillStyle = statusColor(pal, status);
    ctx.beginPath();
    for (const c of list) {
      ctx.moveTo(c.x + c.w - 11, c.y + 15);
      ctx.arc(c.x + c.w - 15, c.y + 15, 4, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  if (scene.labels) {
    ctx.fillStyle = pal.text;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const [dim, list] of group(cards, (c) => (c.dim ? '1' : '0'))) {
      ctx.globalAlpha = dim === '1' ? 0.13 : 1;
      for (const c of list) {
        ctx.font = `600 ${c.n.kind === 'group' ? 15 : 13.5}px "Space Grotesk", system-ui, sans-serif`;
        ctx.fillText(c.n.label, c.x + 12, c.y + c.h / 2, c.w - 24);
      }
    }
  }
  for (const it of top) drawCard(it, it.n.key === scene.selKey, it.n.key === scene.hoverKey);
  ctx.globalAlpha = 1;
}
