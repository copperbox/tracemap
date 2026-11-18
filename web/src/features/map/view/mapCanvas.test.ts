import { describe, expect, it } from 'vitest';
import type { EdgeGeometry } from '../../../lib/edgeGeometry';
import type { GraphEdge } from '../../../lib/grouping';
import { buildEdgeViews, type EdgeView } from './edgeViews';
import { drawMap, type CanvasScene, type MapPalette } from './mapCanvas';

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
  triangles: number;
  alpha: number;
}

/** A 2D context that records what each stroke() and fill() was asked to draw. */
function recorder() {
  let curves: string[] = [];
  let moves = 0;
  let at = '';
  const strokes: Drawn[] = [];
  const fills: Drawn[] = [];
  const noop = (): void => {};
  const ctx = {
    globalAlpha: 1,
    setTransform: noop,
    clearRect: noop,
    roundRect: noop,
    rect: noop,
    arc: noop,
    fillRect: noop,
    fillText: noop,
    setLineDash: noop,
    lineTo: noop,
    closePath: noop,
    measureText: () => ({ width: 0 }),
    beginPath() {
      curves = [];
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
      strokes.push({ curves, triangles: 0, alpha: this.globalAlpha });
    },
    fill() {
      fills.push({ curves: [], triangles: moves, alpha: this.globalAlpha });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes, fills };
}

/** `n` healthy edges fanned across a 2000 x 1000 view; `away` are moved far off screen. */
function edgeViews(n: number, away: ReadonlySet<number> = new Set()): EdgeView[] {
  const edges: GraphEdge[] = [];
  const geoms = new Map<string, EdgeGeometry>();
  for (let i = 0; i < n; i++) {
    const key = `s${i}=>t${i}`;
    const x = away.has(i) ? 1e6 : (i * 7) % 1900;
    edges.push({
      key,
      sourceKey: `s${i}`,
      targetKey: `t${i}`,
      status: 'ok',
      rps: 10,
      p95: 50,
      errPct: 0,
      stale: false,
      confidence: 99,
      samples: 100,
      underlying: [],
    });
    geoms.set(key, {
      d: '',
      curve: { a: { x, y: 10 }, c1: { x, y: 300 }, c2: { x: x + 50, y: 600 }, b: { x: x + 50, y: 900 } },
      arrow: '',
      arrowPts: [
        { x: x + 50, y: 900 },
        { x: x + 45, y: 890 },
        { x: x + 55, y: 890 },
      ],
      mid: { x: x + 25, y: 450 },
    });
  }
  return buildEdgeViews(edges, geoms, { dimmed: () => false, selEdgeKey: null, hoverEdge: null, fadeInOf: () => 1 });
}

function draw(edges: EdgeView[]) {
  const scene: CanvasScene = {
    drawNodes: false,
    frameTitles: false,
    labels: false,
    nodes: [],
    posOf: () => undefined,
    dimmed: () => false,
    selKey: null,
    hoverKey: null,
    frames: [],
    edges,
  };
  const rec = recorder();
  drawMap(rec.ctx, scene, { tx: 0, ty: 0, k: 1 }, 2000, 1000, 1, PAL);
  return rec;
}

describe('drawMap edges', () => {
  it('never puts more than 64 edges in one path', () => {
    const { strokes } = draw(edgeViews(1000));
    expect(strokes.reduce((n, s) => n + s.curves.length, 0)).toBe(1000);
    expect(Math.max(...strokes.map((s) => s.curves.length))).toBeLessThanOrEqual(64);
    expect(strokes.length).toBe(Math.ceil(1000 / 64));
  });

  it('keeps every other path identical when an edge leaves the screen', () => {
    const all = draw(edgeViews(1000)).strokes.map((s) => s.curves.join(' '));
    // edge 70 sits in the second path (edges 64..127)
    const culled = draw(edgeViews(1000, new Set([70]))).strokes.map((s) => s.curves.join(' '));
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
});
