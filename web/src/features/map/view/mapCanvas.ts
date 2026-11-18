import type { GraphNode } from '../../../lib/grouping';
import { GROUP_H, GROUP_W, NODE_H, NODE_W } from '../../../lib/layout';
import type { Pos } from '../../../lib/transition';
import { edgeStroke, healthyEdgeFade, type EdgeStroke } from './edgeDensity';
import type { EdgeView } from './edgeViews';
import type { FrameView } from './frameViews';
import type { Transform } from './usePanZoom';
import type { WorldRect } from './viewport';

/**
 * Canvas half of the layered map. Frames and edges always draw here; nodes
 * draw here only at the overview level of detail, where DOM cards would be
 * unreadable anyway. Drawing happens in world coordinates under the camera
 * transform, culled to the screen.
 *
 * Nothing here depends on the pointer: hover and selection highlights go to
 * a second canvas (drawOverlay), so moving the mouse never redraws the map.
 *
 * Paths stay small (see PATH_CHUNK_SHIFT) and plain rectangles go through
 * fillRect. Firefox draws both on the GPU but falls back to software for one
 * path holding hundreds of curves or rounded rectangles.
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
  frames: FrameView[];
  edges: EdgeView[];
  /** The camera is mid-gesture: a dense healthy mesh may be drawn from its last bitmap (see MeshCache). */
  moving?: boolean;
  /** Changes whenever any edge's curve does (the geometry map); the mesh bitmap is keyed on it. */
  geomKey?: unknown;
}

/** Pointer and selection highlights, drawn over the map by drawOverlay. */
export interface MapOverlay {
  hoverEdge: EdgeView | null;
  selEdge: EdgeView | null;
  /** Canvas level of detail only; at card zoom the DOM card shows its own state. */
  hoverNode: GraphNode | null;
  selNode: GraphNode | null;
  posOf: (key: string) => Pos | undefined;
  dimmed: (key: string) => boolean;
}

/**
 * The healthy edge mesh as a bitmap. With thousands of edges on screen the
 * mesh is the bulk of a frame, and every zoom step invalidates each path a
 * browser cached for it. While the camera moves, the last bitmap is drawn
 * scaled and shifted instead; it is rendered again once it has drifted past
 * MESH_ZOOM_SLACK or MESH_PAN_SLACK, and when the camera rests.
 *
 * The bitmap outlives a live update. It is keyed on the edge curves and on
 * each edge's dimming, selection and focus, not on status: an edge that turns
 * unhealthy is drawn at full strength over its faint line in the bitmap, and
 * one that recovers is missing from it only until the next render (at most
 * MESH_MISSING_MAX of them, among thousands at a few percent opacity).
 */
export interface MeshCache {
  /** Makes the bitmap's canvas on first use. */
  create: () => HTMLCanvasElement;
  canvas: HTMLCanvasElement | null;
  /** Hash of every edge's index and flags, and the healthy edge count, when the bitmap was rendered. */
  sig: number;
  healthy: number;
  geomKey: unknown;
  pal: MapPalette | null;
  w: number;
  h: number;
  dpr: number;
  tf: Transform | null;
}

export const newMeshCache = (create: () => HTMLCanvasElement = () => document.createElement('canvas')): MeshCache => ({
  create,
  canvas: null,
  sig: 0,
  healthy: 0,
  geomKey: null,
  pal: null,
  w: 0,
  h: 0,
  dpr: 0,
  tf: null,
});

export interface DrawResult {
  /** Fade applied to healthy edges (see edgeDensity). */
  fade: number;
  /** The mesh came from a bitmap rendered for another camera position. */
  meshStale: boolean;
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
/** Smallest on-screen width of a degraded or critical node block. */
const BAD_BLOCK_MIN_PX = 7;
/** Corner radius of a canvas card, in world px (the DOM card's). */
const CARD_RADIUS = 11;
/** Below this on-screen corner radius a canvas card is drawn square, with fillRect. */
const ROUND_MIN_PX = 2.5;
/**
 * Edges (or rounded rectangles) per canvas path, as a shift (64). Firefox
 * draws a small path on the GPU and caches it while it only moves, but
 * rasterizes a path of a thousand curves in software: 150 to 600 ms a frame
 * on a 4K canvas. Edge paths are cut by scene order, not by what is on
 * screen, so a pan that culls a few edges leaves every other path identical
 * to the previous frame's.
 */
const PATH_CHUNK_SHIFT = 6;
const PATH_CHUNK = 1 << PATH_CHUNK_SHIFT;
/** Arrowheads fainter than this are not drawn: a dense mesh would double its geometry for nothing visible. */
const ARROW_MIN_OP = 0.2;
/** Visible healthy edges at or above which the mesh goes through its bitmap. */
const MESH_CACHE_MIN = 1500;
/** A moving camera reuses the mesh bitmap while the zoom is within this factor of the bitmap's... */
const MESH_ZOOM_SLACK = 1.3;
/** ...and the bitmap has shifted by less than this fraction of the canvas. */
const MESH_PAN_SLACK = 0.12;
/** Healthy edges that may be missing from the bitmap before it is rendered again. */
const MESH_MISSING_MAX = 32;

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

// Width of each frame title at FRAME_LABEL_PX, in screen px. A title is
// measured once, not once per frame for every team on screen.
const titleWidths = new Map<string, number>();
const TITLE_FONT = (px: number): string => `700 ${px}px "Space Grotesk", system-ui, sans-serif`;

/** Forget measured text widths (a web font finished loading). */
export function resetCanvasTextCache(): void {
  titleWidths.clear();
}

function statusColor(pal: MapPalette, status: string): string {
  return status === 'crit' ? pal.crit : status === 'warn' ? pal.warn : pal.ok;
}

function groupBy<T>(list: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of list) {
    const key = keyOf(item);
    const arr = m.get(key);
    if (arr) arr.push(item);
    else m.set(key, [item]);
  }
  return m;
}

interface NodeItem {
  n: GraphNode;
  x: number;
  y: number;
  w: number;
  h: number;
  dim: boolean;
}

/** One node as a canvas card (or a block when too small), with its selection or hover ring. */
function drawCard(
  ctx: CanvasRenderingContext2D,
  pal: MapPalette,
  k: number,
  it: NodeItem,
  opts: { sel: boolean; hover: boolean; labels: boolean },
): void {
  const { n, x, y, w, h } = it;
  const px = 1 / k;
  const sc = statusColor(pal, n.status);
  ctx.globalAlpha = it.dim ? 0.13 : 1;
  if (w * k < BLOCK_NODE_PX) {
    ctx.fillStyle = n.status === 'ok' ? pal.faint : sc;
    ctx.fillRect(x, y, w, h);
  } else {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, CARD_RADIUS);
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
    if (opts.labels || opts.sel || opts.hover) {
      ctx.fillStyle = pal.text;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = `600 ${n.kind === 'group' ? 15 : 13.5}px "Space Grotesk", system-ui, sans-serif`;
      ctx.fillText(n.label, x + 12, y + h / 2, w - 24);
    }
  }
  if (opts.sel || opts.hover) {
    ctx.globalAlpha = it.dim ? 0.3 : 1;
    ctx.beginPath();
    const o = (opts.sel ? 4 : 2.5) * px;
    ctx.roundRect(x - o, y - o, w + 2 * o, h + 2 * o, CARD_RADIUS + o);
    ctx.lineWidth = (opts.sel ? 2.5 : 1.5) * px;
    ctx.strokeStyle = opts.sel ? (n.status === 'ok' ? pal.accent : sc) : pal.accent;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

export function drawMap(
  ctx: CanvasRenderingContext2D,
  scene: CanvasScene,
  tf: Transform,
  cssW: number,
  cssH: number,
  dpr: number,
  pal: MapPalette,
  mesh?: MeshCache,
): DrawResult {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const k = tf.k;
  if (!(k > 0)) return { fade: 1, meshStale: false };
  const view = screenWorld(tf, cssW, cssH, 24);
  const toWorld = (c: CanvasRenderingContext2D): void => c.setTransform(dpr * k, 0, 0, dpr * k, dpr * tf.tx, dpr * tf.ty);
  toWorld(ctx);
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
      let width = titleWidths.get(f.name);
      if (width === undefined) {
        if (titleWidths.size > 4096) titleWidths.clear();
        ctx.font = TITLE_FONT(fontPx);
        width = ctx.measureText(f.name).width;
        titleWidths.set(f.name, width);
      }
      // a name that does not fit its frame would run into the neighbor's
      if (width * px > f.w - 20 * px) continue;
      ctx.font = TITLE_FONT(fontPx * px);
      ctx.globalAlpha = f.dim ? 0.13 : 1;
      ctx.fillStyle = pal.text;
      ctx.fillText(f.name, f.x + 4 * px, f.y - 4 * px);
    }
  }
  ctx.globalAlpha = 1;

  // ---- edges ----
  // Healthy and unhealthy edges are drawn in separate passes so degraded and
  // critical ones always land on top, and healthy ones fade as the visible
  // edge count grows (see edgeDensity). Lists hold indices into scene.edges,
  // in scene order.
  const edges = scene.edges;
  const healthy: number[] = [];
  const unhealthy: number[] = [];
  // what the mesh bitmap depends on besides the curves, over every edge (not
  // only the visible ones, or it would change with the camera)
  let meshSig = edges.length;
  let healthyAll = 0;
  for (let i = 0; i < edges.length; i++) {
    const v = edges[i];
    meshSig = (Math.imul(meshSig, 31) + (v.dim ? 1 : 0) + (v.isSel ? 2 : 0) + (v.focused ? 4 : 0) + ((v.fadeIn * 1024) | 0) * 8) | 0;
    if (v.e.status === 'ok') healthyAll++;
    const c = v.curve;
    const x0 = Math.min(c.a.x, c.b.x, c.c1.x, c.c2.x);
    const x1 = Math.max(c.a.x, c.b.x, c.c1.x, c.c2.x);
    const y0 = Math.min(c.a.y, c.b.y, c.c1.y, c.c2.y);
    const y1 = Math.max(c.a.y, c.b.y, c.c1.y, c.c2.y);
    if (outside(view, x0, y0, x1, y1)) continue;
    (v.e.status === 'ok' ? healthy : unhealthy).push(i);
  }
  const fade = healthyEdgeFade(healthy.length + unhealthy.length);
  ctx.lineCap = 'round';
  const strokeEdges = (c: CanvasRenderingContext2D, at: number[]): void => {
    // one path per style and per run of 64 edges in scene order
    const buckets = new Map<string, { st: EdgeStroke; list: EdgeView[] }>();
    for (const i of at) {
      const v = edges[i];
      const st = edgeStroke(v, fade);
      const key = `${i >> PATH_CHUNK_SHIFT}|${v.stroke}|${st.op.toFixed(2)}|${v.w}|${st.arrowOp.toFixed(2)}|${st.minPx}|${st.maxPx}`;
      const b = buckets.get(key);
      if (b) b.list.push(v);
      else buckets.set(key, { st, list: [v] });
    }
    for (const { st, list } of buckets.values()) {
      const v0 = list[0];
      c.globalAlpha = st.op;
      c.strokeStyle = resolveVar(pal, v0.stroke);
      const width = Math.max(v0.w, st.minPx * px);
      c.lineWidth = st.maxPx != null ? Math.min(width, st.maxPx * px) : width;
      c.beginPath();
      for (const v of list) {
        const q = v.curve;
        c.moveTo(q.a.x, q.a.y);
        c.bezierCurveTo(q.c1.x, q.c1.y, q.c2.x, q.c2.y, q.b.x, q.b.y);
      }
      c.stroke();
      if (k >= ARROW_MIN_K && st.arrowOp >= ARROW_MIN_OP) {
        c.globalAlpha = st.arrowOp;
        c.fillStyle = resolveVar(pal, v0.arrowFill);
        c.beginPath();
        for (const v of list) {
          const [a, b, d] = v.arrowPts;
          c.moveTo(a.x, a.y);
          c.lineTo(b.x, b.y);
          c.lineTo(d.x, d.y);
          c.closePath();
        }
        c.fill();
      }
    }
    c.globalAlpha = 1;
  };

  let meshStale = false;
  const strokeHealthy = (): void => {
    if (!mesh || healthy.length < MESH_CACHE_MIN) {
      strokeEdges(ctx, healthy);
      return;
    }
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    const m = mesh.tf;
    const same =
      m != null &&
      mesh.canvas != null &&
      mesh.sig === meshSig &&
      mesh.geomKey === scene.geomKey &&
      healthyAll <= mesh.healthy + MESH_MISSING_MAX &&
      mesh.pal === pal &&
      mesh.w === pw &&
      mesh.h === ph &&
      mesh.dpr === dpr;
    const r = m ? k / m.k : 1;
    const ox = m ? dpr * (tf.tx - m.tx * r) : 0;
    const oy = m ? dpr * (tf.ty - m.ty * r) : 0;
    const exact = same && r === 1 && ox === 0 && oy === 0;
    const reuse =
      same &&
      scene.moving === true &&
      r <= MESH_ZOOM_SLACK &&
      r >= 1 / MESH_ZOOM_SLACK &&
      Math.abs(ox) <= MESH_PAN_SLACK * pw &&
      Math.abs(oy) <= MESH_PAN_SLACK * ph &&
      Math.abs(ox + pw * r - pw) <= MESH_PAN_SLACK * pw &&
      Math.abs(oy + ph * r - ph) <= MESH_PAN_SLACK * ph;
    if (!exact && !reuse) {
      const cv = (mesh.canvas ??= mesh.create());
      if (cv.width !== pw || cv.height !== ph) {
        cv.width = pw;
        cv.height = ph;
      }
      const mc = cv.getContext('2d');
      if (!mc) {
        strokeEdges(ctx, healthy);
        return;
      }
      mc.setTransform(1, 0, 0, 1, 0, 0);
      mc.clearRect(0, 0, pw, ph);
      toWorld(mc);
      mc.lineCap = 'round';
      strokeEdges(mc, healthy);
      mesh.sig = meshSig;
      mesh.healthy = healthyAll;
      mesh.geomKey = scene.geomKey;
      mesh.pal = pal;
      mesh.w = pw;
      mesh.h = ph;
      mesh.dpr = dpr;
      mesh.tf = tf;
    }
    if (!mesh.canvas) return;
    ctx.globalAlpha = 1;
    if (exact || !reuse) ctx.setTransform(1, 0, 0, 1, 0, 0);
    else {
      ctx.setTransform(r, 0, 0, r, ox, oy);
      meshStale = true;
    }
    ctx.drawImage(mesh.canvas, 0, 0);
    toWorld(ctx);
  };

  if (!scene.drawNodes) {
    strokeHealthy();
    strokeEdges(ctx, unhealthy);
    return { fade, meshStale };
  }

  // ---- nodes ----
  const okNodes: NodeItem[] = [];
  const badNodes: NodeItem[] = [];
  for (const n of scene.nodes) {
    const p = scene.posOf(n.key);
    if (!p) continue;
    const { w, h } = sizeOf(n);
    if (outside(view, p.x, p.y, p.x + w, p.y + h)) continue;
    (n.status === 'ok' ? okNodes : badNodes).push({ n, x: p.x, y: p.y, w, h, dim: scene.dimmed(n.key) });
  }

  // A crowded overview draws healthy edges, healthy nodes, then the unhealthy
  // edges and nodes over them. Otherwise nodes sit over every edge, as cards do.
  if (fade < 1) {
    strokeHealthy();
    drawNodeSet(okNodes);
    strokeEdges(ctx, unhealthy);
    drawNodeSet(badNodes);
  } else {
    strokeHealthy();
    strokeEdges(ctx, unhealthy);
    drawNodeSet(okNodes);
    drawNodeSet(badNodes);
  }
  ctx.globalAlpha = 1;
  return { fade, meshStale };

  function drawNodeSet(items: NodeItem[]): void {
    const blocks: NodeItem[] = [];
    const cards: NodeItem[] = [];
    for (const it of items) (it.w * k < BLOCK_NODE_PX ? blocks : cards).push(it);
    const blockColor = (n: GraphNode): string =>
      n.status === 'ok' ? (n.kind === 'group' ? pal.dim : pal.faint) : statusColor(pal, n.status);
    for (const [key, list] of groupBy(blocks, (it) => `${blockColor(it.n)}|${it.dim ? 1 : 0}`)) {
      const [color, dim] = key.split('|');
      ctx.globalAlpha = dim === '1' ? 0.13 : 1;
      ctx.fillStyle = color;
      for (const r of list) {
        // an unhealthy service never shrinks below a few screen pixels
        if (r.n.status !== 'ok' && (r.w * k < BAD_BLOCK_MIN_PX || r.h * k < BAD_BLOCK_MIN_PX * 0.6)) {
          const bw = Math.max(r.w, BAD_BLOCK_MIN_PX * px);
          const bh = Math.max(r.h, BAD_BLOCK_MIN_PX * 0.6 * px);
          ctx.fillRect(r.x + (r.w - bw) / 2, r.y + (r.h - bh) / 2, bw, bh);
        } else {
          ctx.fillRect(r.x, r.y, r.w, r.h);
        }
      }
    }
    ctx.globalAlpha = 1;
    if (CARD_RADIUS * k < ROUND_MIN_PX) drawSquareCards(cards);
    else drawRoundCards(cards);
    if (scene.labels) {
      ctx.fillStyle = pal.text;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      // one font assignment per kind, not per card
      for (const [key, list] of groupBy(cards, (c) => `${c.dim ? 1 : 0}|${c.n.kind === 'group' ? 15 : 13.5}`)) {
        const [dim, size] = key.split('|');
        ctx.globalAlpha = dim === '1' ? 0.13 : 1;
        ctx.font = `600 ${size}px "Space Grotesk", system-ui, sans-serif`;
        for (const c of list) ctx.fillText(c.n.label, c.x + 12, c.y + c.h / 2, c.w - 24);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Small mid-zoom cards: a border-colored rectangle, the panel inset on it,
  // and a square for the status dot. Their corners and dashes would be under
  // 3 px, and plain rectangles are the cheapest thing a canvas draws.
  function drawSquareCards(cards: NodeItem[]): void {
    const bw = Math.max(1.2, px);
    for (const [key, list] of groupBy(cards, (c) => `${c.n.status}|${c.dim ? 1 : 0}`)) {
      const [status, dim] = key.split('|');
      ctx.globalAlpha = dim === '1' ? 0.13 : 1;
      ctx.fillStyle = status === 'ok' ? pal.line : statusColor(pal, status);
      for (const c of list) ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.fillStyle = pal.panel;
      for (const c of list) ctx.fillRect(c.x + bw, c.y + bw, c.w - 2 * bw, c.h - 2 * bw);
      ctx.fillStyle = statusColor(pal, status);
      for (const c of list) ctx.fillRect(c.x + c.w - 19, c.y + 11, 8, 8);
    }
  }

  // Larger cards, batched: one fill for the panels, then one stroke and one
  // dot pass per style, in paths of at most PATH_CHUNK cards.
  function drawRoundCards(cards: NodeItem[]): void {
    const chunks = (list: NodeItem[], draw: (part: NodeItem[]) => void): void => {
      for (let i = 0; i < list.length; i += PATH_CHUNK) draw(list.slice(i, i + PATH_CHUNK));
    };
    for (const [dim, list] of groupBy(cards, (c) => (c.dim ? '1' : '0'))) {
      ctx.globalAlpha = dim === '1' ? 0.13 : 1;
      ctx.fillStyle = pal.panel;
      chunks(list, (part) => {
        ctx.beginPath();
        for (const c of part) ctx.roundRect(c.x, c.y, c.w, c.h, CARD_RADIUS);
        ctx.fill();
      });
    }
    for (const [key, list] of groupBy(cards, (c) => `${c.n.status}|${c.dim ? 1 : 0}|${isDashed(c.n) ? 1 : 0}`)) {
      const [status, dim, dashed] = key.split('|');
      ctx.globalAlpha = dim === '1' ? 0.13 : 1;
      ctx.strokeStyle = status === 'ok' ? pal.line : statusColor(pal, status);
      ctx.lineWidth = Math.max(1.2, px);
      if (dashed === '1') ctx.setLineDash([5, 4]);
      // a dashed stroke is rasterized in software over its bounds: one card per path keeps those small
      chunks(dashed === '1' ? [] : list, (part) => {
        ctx.beginPath();
        for (const c of part) ctx.roundRect(c.x, c.y, c.w, c.h, CARD_RADIUS);
        ctx.stroke();
      });
      if (dashed === '1') {
        for (const c of list) {
          ctx.beginPath();
          ctx.roundRect(c.x, c.y, c.w, c.h, CARD_RADIUS);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
    }
    for (const [key, list] of groupBy(cards, (c) => `${c.n.status}|${c.dim ? 1 : 0}`)) {
      const [status, dim] = key.split('|');
      ctx.globalAlpha = dim === '1' ? 0.13 : 1;
      ctx.fillStyle = statusColor(pal, status);
      chunks(list, (part) => {
        ctx.beginPath();
        for (const c of part) {
          ctx.moveTo(c.x + c.w - 11, c.y + 15);
          ctx.arc(c.x + c.w - 15, c.y + 15, 4, 0, Math.PI * 2);
        }
        ctx.fill();
      });
    }
  }
}

/**
 * Highlights on the overlay canvas: the hovered edge, the selected edge with
 * its glow (on top, so a crowd cannot hide it), and at the canvas level of
 * detail the hovered and selected nodes. Returns whether anything was drawn,
 * so the caller can hide an empty overlay.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  o: MapOverlay,
  tf: Transform,
  cssW: number,
  cssH: number,
  dpr: number,
  pal: MapPalette,
  labels: boolean,
): boolean {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const k = tf.k;
  if (!(k > 0)) return false;
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tf.tx, dpr * tf.ty);
  const px = 1 / k;
  let drawn = false;
  ctx.lineCap = 'round';
  const edge = (v: EdgeView, width: number, op: number, glow: boolean): void => {
    const c = v.curve;
    const color = resolveVar(pal, v.stroke);
    ctx.globalAlpha = op;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (glow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 6 * dpr;
    }
    ctx.beginPath();
    ctx.moveTo(c.a.x, c.a.y);
    ctx.bezierCurveTo(c.c1.x, c.c1.y, c.c2.x, c.c2.y, c.b.x, c.b.y);
    ctx.stroke();
    ctx.shadowBlur = 0;
    if (k >= ARROW_MIN_K) {
      const [a, b, d] = v.arrowPts;
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = resolveVar(pal, v.arrowFill);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    drawn = true;
  };
  // a dimmed edge stays quiet under the pointer, as its card does
  if (o.hoverEdge && !o.hoverEdge.dim && o.hoverEdge !== o.selEdge) edge(o.hoverEdge, Math.max(1.8, 0.6 * px), 0.85, false);
  if (o.selEdge && !o.selEdge.dim) edge(o.selEdge, Math.max(2, 1.6 * px), 0.95, true);
  const node = (n: GraphNode, sel: boolean): void => {
    const p = o.posOf(n.key);
    if (!p) return;
    const { w, h } = sizeOf(n);
    drawCard(ctx, pal, k, { n, x: p.x, y: p.y, w, h, dim: o.dimmed(n.key) }, { sel, hover: !sel, labels });
    drawn = true;
  };
  if (o.hoverNode && o.hoverNode !== o.selNode) node(o.hoverNode, false);
  if (o.selNode) node(o.selNode, true);
  return drawn;
}
