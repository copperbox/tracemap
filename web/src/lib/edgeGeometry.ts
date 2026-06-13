/**
 * Geometry for map edges: which side of each node an edge attaches to, where
 * along that side, and the resulting bezier path + arrowhead + label point.
 *
 * Sides are chosen from the actual relative positions of the two nodes, so
 * direction stays readable even when the layout (or a user drag) puts a
 * dependency beside or below its dependent -- which is common once team
 * grouping aggregates the service graph into something cyclic.
 *
 * Anchors on a shared side are spread out (sorted by where the far endpoint
 * sits) instead of all converging on the side's center point.
 */

export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

export interface EdgeInput {
  key: string;
  /** node the data flows out of (the dependency) */
  fromKey: string;
  /** node the data flows into (the dependent; gets the arrowhead) */
  toKey: string;
}

/** The four control points of an edge's cubic bezier (start, two handles, end). */
export interface CubicCurve {
  a: Pt;
  c1: Pt;
  c2: Pt;
  b: Pt;
}

export interface EdgeGeometry {
  /** bezier path running dependency -> dependent (matches dash/packet flow) */
  d: string;
  /** the same bezier as control points, for evaluating positions along it (packet canvas) */
  curve: CubicCurve;
  /** arrowhead polygon at the entry anchor, pointing into the dependent */
  arrow: string;
  /** point on the curve at t=0.5, for the metric label */
  mid: Pt;
}

const ARROW_LEN = 8;
const ARROW_HALF_W = 4.5;
// anchors spread across the middle of a side, keeping clear of the corners
const SPREAD_MIN = 0.18;
const SPREAD_MAX = 0.82;
// prefer vertical attachment unless the pair is clearly side-by-side, so the
// layered look is kept whenever the layout manages a top-down flow
const VERTICAL_BIAS = 0.55;

const NORMALS: Record<Side, Pt> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const center = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Side of `from` the edge exits and side of `to` it enters. */
export function pickSides(from: Rect, to: Rect): { exit: Side; entry: Side } {
  const a = center(from);
  const b = center(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dy) >= Math.abs(dx) * VERTICAL_BIAS) {
    return dy >= 0 ? { exit: 'bottom', entry: 'top' } : { exit: 'top', entry: 'bottom' };
  }
  return dx >= 0 ? { exit: 'right', entry: 'left' } : { exit: 'left', entry: 'right' };
}

function anchorAt(r: Rect, side: Side, f: number): Pt {
  switch (side) {
    case 'top':
      return { x: r.x + r.w * f, y: r.y };
    case 'bottom':
      return { x: r.x + r.w * f, y: r.y + r.h };
    case 'left':
      return { x: r.x, y: r.y + r.h * f };
    case 'right':
      return { x: r.x + r.w, y: r.y + r.h * f };
  }
}

interface SidePick {
  exit: Side;
  entry: Side;
  from: Rect;
  to: Rect;
}

interface SideEnd {
  /** fraction lookup key: `${edgeKey}|exit` or `${edgeKey}|entry` */
  slot: string;
  /** far-endpoint coordinate used to order anchors along the side */
  order: number;
}

export function computeEdgeGeometries(
  edges: EdgeInput[],
  rectOf: (key: string) => Rect | undefined,
): Map<string, EdgeGeometry> {
  // pass 1: pick sides per edge, collect every attachment per (node, side)
  const picks = new Map<string, SidePick>();
  const sideEnds = new Map<string, SideEnd[]>();
  const addEnd = (nodeKey: string, side: Side, end: SideEnd): void => {
    const k = `${nodeKey}|${side}`;
    const arr = sideEnds.get(k) ?? [];
    arr.push(end);
    sideEnds.set(k, arr);
  };
  for (const e of [...edges].sort((a, b) => a.key.localeCompare(b.key))) {
    const from = rectOf(e.fromKey);
    const to = rectOf(e.toKey);
    if (!from || !to) continue;
    const s = pickSides(from, to);
    picks.set(e.key, { ...s, from, to });
    const fc = center(from);
    const tc = center(to);
    const along = (side: Side, far: Pt): number =>
      side === 'top' || side === 'bottom' ? far.x : far.y;
    addEnd(e.fromKey, s.exit, { slot: `${e.key}|exit`, order: along(s.exit, tc) });
    addEnd(e.toKey, s.entry, { slot: `${e.key}|entry`, order: along(s.entry, fc) });
  }

  // pass 2: spread the anchors that share a side
  const fractions = new Map<string, number>();
  for (const arr of sideEnds.values()) {
    arr.sort((a, b) => a.order - b.order || a.slot.localeCompare(b.slot));
    arr.forEach((end, i) => {
      const f =
        arr.length === 1 ? 0.5 : SPREAD_MIN + ((SPREAD_MAX - SPREAD_MIN) * i) / (arr.length - 1);
      fractions.set(end.slot, f);
    });
  }

  // pass 3: build path, arrowhead and label point per edge
  const out = new Map<string, EdgeGeometry>();
  for (const [key, s] of picks) {
    const a = anchorAt(s.from, s.exit, fractions.get(`${key}|exit`) ?? 0.5);
    const b = anchorAt(s.to, s.entry, fractions.get(`${key}|entry`) ?? 0.5);
    const na = NORMALS[s.exit];
    const nb = NORMALS[s.entry];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const k = Math.max(46, dist * 0.4);
    const c1 = { x: a.x + na.x * k, y: a.y + na.y * k };
    const c2 = { x: b.x + nb.x * k, y: b.y + nb.y * k };
    const bx = b.x + nb.x * ARROW_LEN;
    const by = b.y + nb.y * ARROW_LEN;
    const ux = -nb.y;
    const uy = nb.x;
    out.set(key, {
      d: `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`,
      curve: { a, c1, c2, b },
      arrow:
        `${b.x},${b.y} ` +
        `${bx - ux * ARROW_HALF_W},${by - uy * ARROW_HALF_W} ` +
        `${bx + ux * ARROW_HALF_W},${by + uy * ARROW_HALF_W}`,
      mid: {
        x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8,
        y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8,
      },
    });
  }
  return out;
}
