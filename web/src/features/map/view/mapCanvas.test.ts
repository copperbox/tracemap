import { describe, expect, it } from 'vitest';
import type { EdgeGeometry } from '../../../lib/edgeGeometry';
import type { GraphEdge, GraphNode } from '../../../lib/grouping';
import { buildEdgeViews, type EdgeView } from './edgeViews';
import { drawMap, drawOverlay, newMeshCache, type CanvasScene, type MapPalette } from './mapCanvas';
import type { Transform } from './usePanZoom';

const PAL: MapPalette = {
  panel: '#111',
  line: '#222',
  frameLine: '#333',
  frameBg: '#444',
  text: '#fff',
  dim: '#555',
  faint: '#666',
  ok: '#0f0',
  warn: '#ff0',
  crit: '#f00',
  accent: '#0f0',
};

interface Drawn {
  curves: string[];
  roundRects: number;
  triangles: number;
  alpha: number;
  width: number;
  shadow: number;
}

/** A 2D context that records what each stroke(), fill(), fillRect() and drawImage() was asked to draw. */
function recorder() {
  let curves: string[] = [];
  let roundRects = 0;
  let moves = 0;
  let at = '';
  const strokes: Drawn[] = [];
  const fills: Drawn[] = [];
  const rects: { x: number; y: number; w: number; h: number; style: string }[] = [];
  const images: { source: unknown; transform: number[] }[] = [];
  let transform: number[] = [1, 0, 0, 1, 0, 0];
  const noop = (): void => {};
  const ctx = {
    globalAlpha: 1,
    lineWidth: 1,
    shadowBlur: 0,
    fillStyle: '',
    setTransform(...m: number[]) {
      transform = m;
    },
    clearRect: noop,
    rect: noop,
    arc: noop,
    fillText: noop,
    setLineDash: noop,
    lineTo: noop,
    closePath: noop,
    measureText: () => ({ width: 0 }),
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, style: String(this.fillStyle) });
    },
    roundRect() {
      roundRects++;
    },
    drawImage(source: unknown) {
      images.push({ source, transform });
    },
    beginPath() {
      curves = [];
      roundRects = 0;
      moves = 0;
    },
    moveTo(x: number, y: number) {
      at = `${x},${y}`;
      moves++;
    },
    bezierCurveTo(...p: number[]) {
      curves.push(`${at}>${p.join(',')}`);
    },
    stroke() {
      strokes.push({ curves, roundRects, triangles: 0, alpha: this.globalAlpha, width: this.lineWidth, shadow: this.shadowBlur });
    },
    fill() {
      fills.push({ curves: [], roundRects, triangles: moves, alpha: this.globalAlpha, width: 0, shadow: 0 });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes, fills, rects, images };
}

const curvesIn = (strokes: Drawn[]): number => strokes.reduce((n, s) => n + s.curves.length, 0);

/** `n` edges fanned across a 2000 x 1000 view; `away` are moved far off screen, `bad` are degraded. */
function edgeViews(n: number, opts: { away?: ReadonlySet<number>; bad?: ReadonlySet<number>; sel?: number } = {}): EdgeView[] {
  const edges: GraphEdge[] = [];
  const geoms = new Map<string, EdgeGeometry>();
  for (let i = 0; i < n; i++) {
    const key = `s${i}=>t${i}`;
    const x = opts.away?.has(i) ? 1e6 : (i * 7) % 1900;
    edges.push({
      key,
      sourceKey: `s${i}`,
      targetKey: `t${i}`,
      status: opts.bad?.has(i) ? 'warn' : 'ok',
      rps: 10,
      p95: 50,
      errPct: 0,
      stale: false,
      confidence: 99,
      samples: 100,
      underlying: [],
    });
    geoms.set(key, {
      curve: { a: { x, y: 10 }, c1: { x, y: 300 }, c2: { x: x + 50, y: 600 }, b: { x: x + 50, y: 900 } },
      arrowPts: [
        { x: x + 50, y: 900 },
        { x: x + 45, y: 890 },
        { x: x + 55, y: 890 },
      ],
      mid: { x: x + 25, y: 450 },
    });
  }
  return buildEdgeViews(edges, geoms, {
    dimmed: () => false,
    selEdgeKey: opts.sel != null ? `s${opts.sel}=>t${opts.sel}` : null,
    fadeInOf: () => 1,
  });
}

const node = (i: number, over: Partial<GraphNode> = {}): GraphNode => ({
  key: `n${i}`,
  kind: 'service',
  serviceId: `n${i}`,
  teamId: null,
  teamName: null,
  label: `n${i}`,
  type: 'service',
  status: 'ok',
  rps: 1,
  p95: 10,
  errPct: 0,
  stale: false,
  isExternal: false,
  memberIds: [],
  ...over,
});

const sceneOf = (over: Partial<CanvasScene>): CanvasScene => ({
  drawNodes: false,
  frameTitles: false,
  labels: false,
  nodes: [],
  posOf: () => undefined,
  dimmed: () => false,
  frames: [],
  edges: [],
  ...over,
});

const AT_REST: Transform = { tx: 0, ty: 0, k: 1 };

function draw(edges: EdgeView[]) {
  const rec = recorder();
  drawMap(rec.ctx, sceneOf({ edges }), AT_REST, 2000, 1000, 1, PAL);
  return rec;
}

describe('drawMap edges', () => {
  it('never puts more than 64 edges in one path', () => {
    const { strokes } = draw(edgeViews(1000));
    expect(curvesIn(strokes)).toBe(1000);
    expect(Math.max(...strokes.map((s) => s.curves.length))).toBeLessThanOrEqual(64);
    expect(strokes.length).toBe(Math.ceil(1000 / 64));
  });

  it('keeps every other path identical when an edge leaves the screen', () => {
    const all = draw(edgeViews(1000)).strokes.map((s) => s.curves.join(' '));
    // edge 70 sits in the second path (edges 64..127)
    const culled = draw(edgeViews(1000, { away: new Set([70]) })).strokes.map((s) => s.curves.join(' '));
    expect(culled.length).toBe(all.length);
    const changed = all.flatMap((path, i) => (path === culled[i] ? [] : [i]));
    expect(changed).toEqual([1]);
  });

  it('draws arrowheads on a sparse map and skips the faint ones of a dense mesh', () => {
    const sparse = draw(edgeViews(40));
    expect(sparse.fills.reduce((n, f) => n + f.triangles, 0)).toBe(40);
    const dense = draw(edgeViews(1000));
    expect(dense.strokes.length).toBeGreaterThan(0);
    expect(dense.fills).toEqual([]);
  });

  it('draws the selected edge without a glow: the glow belongs to the overlay', () => {
    const { strokes } = draw(edgeViews(10, { sel: 3 }));
    expect(curvesIn(strokes)).toBe(10);
    expect(strokes.every((s) => s.shadow === 0)).toBe(true);
  });
});

describe('drawMap mesh bitmap', () => {
  /** A stand-in for the bitmap's canvas, recording what is drawn into it. */
  function meshFixture() {
    const rec = recorder();
    const canvas = { width: 0, height: 0, getContext: () => rec.ctx } as unknown as HTMLCanvasElement;
    return { cache: newMeshCache(() => canvas), canvas, rec };
  }
  const dense = edgeViews(2000, { bad: new Set([5, 900]) });

  it('draws a small mesh straight onto the map', () => {
    const { cache, rec: meshRec } = meshFixture();
    const main = recorder();
    drawMap(main.ctx, sceneOf({ edges: edgeViews(400) }), AT_REST, 2000, 1000, 1, PAL, cache);
    expect(curvesIn(main.strokes)).toBe(400);
    expect(main.images).toEqual([]);
    expect(meshRec.strokes).toEqual([]);
  });

  it('renders a dense mesh into the bitmap and blits it; unhealthy edges still draw directly', () => {
    const { cache, canvas, rec: meshRec } = meshFixture();
    const main = recorder();
    const res = drawMap(main.ctx, sceneOf({ edges: dense }), AT_REST, 2000, 1000, 1, PAL, cache);
    expect(curvesIn(meshRec.strokes)).toBe(1998);
    expect(curvesIn(main.strokes)).toBe(2);
    expect(main.images).toEqual([{ source: canvas, transform: [1, 0, 0, 1, 0, 0] }]);
    expect(res.meshStale).toBe(false);
    expect([canvas.width, canvas.height]).toEqual([2000, 1000]);
  });

  it('reuses the bitmap for an identical frame', () => {
    const { cache, rec: meshRec } = meshFixture();
    drawMap(recorder().ctx, sceneOf({ edges: dense }), AT_REST, 2000, 1000, 1, PAL, cache);
    const before = meshRec.strokes.length;
    const main = recorder();
    drawMap(main.ctx, sceneOf({ edges: dense }), AT_REST, 2000, 1000, 1, PAL, cache);
    expect(meshRec.strokes.length).toBe(before);
    expect(main.images).toHaveLength(1);
  });

  it('draws the bitmap scaled and shifted while the camera moves a little', () => {
    const { cache, rec: meshRec } = meshFixture();
    drawMap(recorder().ctx, sceneOf({ edges: dense }), AT_REST, 2000, 1000, 1, PAL, cache);
    const before = meshRec.strokes.length;
    const main = recorder();
    const tf: Transform = { tx: 40, ty: -20, k: 1.1 };
    const res = drawMap(main.ctx, sceneOf({ edges: dense, moving: true }), tf, 2000, 1000, 1, PAL, cache);
    expect(meshRec.strokes.length).toBe(before);
    expect(res.meshStale).toBe(true);
    expect(main.images[0].transform).toEqual([1.1, 0, 0, 1.1, 40, -20]);
  });

  it('renders the bitmap again once the camera rests, and when it has drifted too far', () => {
    const { cache, rec: meshRec } = meshFixture();
    drawMap(recorder().ctx, sceneOf({ edges: dense }), AT_REST, 2000, 1000, 1, PAL, cache);
    const n0 = meshRec.strokes.length;

    // at rest at a new position: never a stale bitmap
    const rest = drawMap(recorder().ctx, sceneOf({ edges: dense }), { tx: 40, ty: 0, k: 1 }, 2000, 1000, 1, PAL, cache);
    expect(rest.meshStale).toBe(false);
    const n1 = meshRec.strokes.length;
    expect(n1).toBeGreaterThan(n0);

    // moving, but zoomed out well past the slack
    const far = drawMap(recorder().ctx, sceneOf({ edges: dense, moving: true }), { tx: 40, ty: 0, k: 0.5 }, 2000, 1000, 1, PAL, cache);
    expect(far.meshStale).toBe(false);
    expect(meshRec.strokes.length).toBeGreaterThan(n1);
  });

  it('keeps the bitmap across a live update: new edge objects, same curves and flags', () => {
    const { cache, rec: meshRec } = meshFixture();
    const geomKey = {};
    drawMap(recorder().ctx, sceneOf({ edges: dense, geomKey }), AT_REST, 2000, 1000, 1, PAL, cache);
    const before = meshRec.strokes.length;
    // every view is a new object, and one more edge has turned unhealthy
    const next = edgeViews(2000, { bad: new Set([5, 900, 1200]) });
    const main = recorder();
    drawMap(main.ctx, sceneOf({ edges: next, geomKey }), AT_REST, 2000, 1000, 1, PAL, cache);
    expect(meshRec.strokes.length).toBe(before);
    // the three unhealthy edges draw at full strength over the bitmap
    expect(curvesIn(main.strokes)).toBe(3);
    expect(main.images).toHaveLength(1);
  });

  it('renders the bitmap again when curves, flags or many statuses change', () => {
    const render = (first: Partial<CanvasScene>, second: Partial<CanvasScene>): boolean => {
      const { cache, rec: meshRec } = meshFixture();
      drawMap(recorder().ctx, sceneOf({ edges: dense, ...first }), AT_REST, 2000, 1000, 1, PAL, cache);
      const before = meshRec.strokes.length;
      drawMap(recorder().ctx, sceneOf({ edges: dense, ...second }), AT_REST, 2000, 1000, 1, PAL, cache);
      return meshRec.strokes.length > before;
    };
    expect(render({ geomKey: 1 }, { geomKey: 2 })).toBe(true);
    expect(render({}, { edges: edgeViews(2000, { bad: new Set([5, 900]), sel: 7 }) })).toBe(true);
    expect(render({}, { edges: dense.map((v, i) => (i === 3 ? { ...v, dim: true } : v)) })).toBe(true);
    // forty edges recovered at once: more than may be missing from the bitmap
    const sick = edgeViews(2000, { bad: new Set(Array.from({ length: 42 }, (_, i) => i * 3)) });
    expect(render({ edges: sick }, { edges: dense })).toBe(true);
    // a few recovering is tolerated
    const fewSick = edgeViews(2000, { bad: new Set([5, 900, 1200, 1300]) });
    expect(render({ edges: fewSick }, { edges: dense })).toBe(false);
  });

  it('counts recovered edges themselves, not the change in how many are healthy', () => {
    // 4,000 edges, half degraded; then every status swaps. As many are healthy
    // as before, but the 2,000 that recovered are not in the bitmap.
    const firstHalf = new Set(Array.from({ length: 2000 }, (_, i) => i));
    const secondHalf = new Set(Array.from({ length: 2000 }, (_, i) => i + 2000));
    const { cache, rec: meshRec } = meshFixture();
    drawMap(recorder().ctx, sceneOf({ edges: edgeViews(4000, { bad: firstHalf }) }), AT_REST, 2000, 1000, 1, PAL, cache);
    const before = curvesIn(meshRec.strokes);
    expect(before).toBe(2000);
    drawMap(recorder().ctx, sceneOf({ edges: edgeViews(4000, { bad: secondHalf }) }), AT_REST, 2000, 1000, 1, PAL, cache);
    expect(curvesIn(meshRec.strokes)).toBe(before + 2000);
  });

  it('tells apart two dimming states exactly, with no hash to collide', () => {
    // the two sets a 32-bit rolling hash of the flags could not tell apart
    const dimming = (set: number[]): EdgeView[] => dense.map((v, i) => (set.includes(i) ? { ...v, dim: true } : v));
    const { cache, rec: meshRec } = meshFixture();
    drawMap(recorder().ctx, sceneOf({ edges: dimming([8, 10, 15, 18, 31]) }), AT_REST, 2000, 1000, 1, PAL, cache);
    const before = meshRec.strokes.length;
    drawMap(recorder().ctx, sceneOf({ edges: dimming([0, 1, 4, 7, 11, 14, 16, 19, 26]) }), AT_REST, 2000, 1000, 1, PAL, cache);
    expect(meshRec.strokes.length).toBeGreaterThan(before);
  });
});

describe('drawMap nodes', () => {
  const nodes = Array.from({ length: 300 }, (_, i) => node(i, i % 50 === 0 ? { status: 'crit' } : {}));
  const posOf = (key: string) => {
    const i = Number(key.slice(1));
    return { x: (i % 20) * 240, y: Math.floor(i / 20) * 110 };
  };
  const scene = sceneOf({ drawNodes: true, nodes, posOf });
  const drawAt = (k: number) => {
    const rec = recorder();
    drawMap(rec.ctx, scene, { tx: 0, ty: 0, k }, 6000, 3000, 1, PAL);
    return rec;
  };

  it('draws far-out nodes as plain rectangles, one fillRect each', () => {
    const { rects, fills, strokes } = drawAt(0.05);
    expect(rects).toHaveLength(300);
    expect(fills).toEqual([]);
    expect(strokes).toEqual([]);
  });

  it('draws small cards square: no rounded-rectangle paths at all', () => {
    const { rects, fills, strokes } = drawAt(0.15);
    // border, panel and status dot per card
    expect(rects).toHaveLength(900);
    expect(fills.concat(strokes).every((d) => d.roundRects === 0)).toBe(true);
  });

  it('draws larger cards rounded, at most 64 to a path', () => {
    const { fills, strokes } = drawAt(0.4);
    const rounded = fills.concat(strokes).filter((d) => d.roundRects > 0);
    expect(rounded.length).toBeGreaterThan(0);
    expect(Math.max(...rounded.map((d) => d.roundRects))).toBeLessThanOrEqual(64);
    // every card gets a panel fill and a border stroke
    expect(fills.reduce((n, d) => n + d.roundRects, 0)).toBe(300);
    expect(strokes.reduce((n, d) => n + d.roundRects, 0)).toBe(300);
  });
});

describe('drawOverlay', () => {
  const edges = edgeViews(10, { sel: 3 });
  const base = { hoverEdge: null, selEdge: null, hoverNode: null, selNode: null, posOf: () => undefined, dimmed: () => false };

  it('draws nothing, and says so, when nothing is highlighted', () => {
    const rec = recorder();
    expect(drawOverlay(rec.ctx, base, AT_REST, 2000, 1000, 1, PAL, false)).toBe(false);
    expect(rec.strokes).toEqual([]);
  });

  it('draws the hovered edge alone, wider than a resting edge and without a glow', () => {
    const rec = recorder();
    expect(drawOverlay(rec.ctx, { ...base, hoverEdge: edges[0] }, AT_REST, 2000, 1000, 1, PAL, false)).toBe(true);
    expect(rec.strokes).toHaveLength(1);
    expect(rec.strokes[0].curves).toHaveLength(1);
    expect(rec.strokes[0].width).toBeCloseTo(1.8);
    expect(rec.strokes[0].shadow).toBe(0);
  });

  it('draws the selected edge with its glow, once, even while it is also hovered', () => {
    const rec = recorder();
    drawOverlay(rec.ctx, { ...base, hoverEdge: edges[3], selEdge: edges[3] }, AT_REST, 2000, 1000, 2, PAL, false);
    expect(rec.strokes).toHaveLength(1);
    expect(rec.strokes[0].shadow).toBe(12);
  });

  it('leaves a dimmed edge alone', () => {
    const rec = recorder();
    const dimmed = { ...edges[0], dim: true };
    expect(drawOverlay(rec.ctx, { ...base, hoverEdge: dimmed }, AT_REST, 2000, 1000, 1, PAL, false)).toBe(false);
  });

  it('rings a hovered node at the canvas level of detail', () => {
    const rec = recorder();
    const n = node(1);
    const drawn = drawOverlay(rec.ctx, { ...base, hoverNode: n, posOf: () => ({ x: 100, y: 100 }) }, AT_REST, 2000, 1000, 1, PAL, false);
    expect(drawn).toBe(true);
    // the card's border and the ring around it
    expect(rec.strokes.filter((s) => s.roundRects === 1)).toHaveLength(2);
  });
});
