/**
 * Layered DAG layout from the design handoff: leaf dependencies (no outgoing
 * edges) at the TOP (layer 0), callers below, funneling down to the gateway.
 * Within a layer nodes sit at the mean x of their dependencies, with one
 * refinement pass re-ordering layer 0 by the mean x of its callers.
 *
 * Cycles (common in the team-grouped graph, where aggregation makes most
 * teams mutually dependent) are handled with a greedy feedback-arc ordering
 * (Eades-Lin-Smyth): layers come from the longest path over the FORWARD
 * edges only, so the dominant flow still runs top-to-bottom and only a
 * minimal set of backward edges points up -- the renderer's direction-aware
 * anchors keep those readable.
 */

export interface LayoutInput {
  keys: string[];
  /** outgoing dependency lists: key -> keys it depends on */
  deps: Map<string, string[]>;
}

export interface LayoutResult {
  pos: Map<string, { x: number; y: number }>;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export const NODE_W = 188;
export const NODE_H = 74;
export const GROUP_W = 206;
export const GROUP_H = 96;
const PX = 216;
const PY = 196;

export function layoutGraph(input: LayoutInput): LayoutResult {
  const { keys, deps } = input;
  if (!keys.length) {
    return { pos: new Map(), bbox: { x0: 0, y0: 0, x1: 0, y1: 0 } };
  }

  // "feed" graph: dependency -> dependent (data flows down the screen)
  const keySet = new Set(keys);
  const feeds = new Map<string, Set<string>>();
  const fedBy = new Map<string, Set<string>>();
  for (const k of keys) {
    feeds.set(k, new Set());
    fedBy.set(k, new Set());
  }
  for (const k of keys) {
    for (const d of deps.get(k) ?? []) {
      if (d === k || !keySet.has(d)) continue;
      (feeds.get(d) as Set<string>).add(k);
      (fedBy.get(k) as Set<string>).add(d);
    }
  }

  // Greedy feedback-arc ordering (Eades-Lin-Smyth): peel sinks to the tail
  // and sources to the head; when neither exists (a cycle), take the node
  // with the best out-minus-in degree. Ties resolve in key order, keeping
  // the layout deterministic. On a DAG this is a plain topological order,
  // so acyclic graphs lay out exactly as before.
  const remaining = new Set(keys);
  const outdeg = new Map(keys.map((k) => [k, (feeds.get(k) as Set<string>).size]));
  const indeg = new Map(keys.map((k) => [k, (fedBy.get(k) as Set<string>).size]));
  const head: string[] = [];
  const tail: string[] = [];
  const removeNode = (k: string): void => {
    remaining.delete(k);
    for (const v of feeds.get(k) as Set<string>) {
      if (remaining.has(v)) indeg.set(v, (indeg.get(v) as number) - 1);
    }
    for (const v of fedBy.get(k) as Set<string>) {
      if (remaining.has(v)) outdeg.set(v, (outdeg.get(v) as number) - 1);
    }
  };
  while (remaining.size) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const k of [...remaining]) {
        if (remaining.has(k) && outdeg.get(k) === 0) {
          removeNode(k);
          tail.unshift(k);
          moved = true;
        }
      }
      for (const k of [...remaining]) {
        if (remaining.has(k) && indeg.get(k) === 0) {
          removeNode(k);
          head.push(k);
          moved = true;
        }
      }
    }
    if (remaining.size) {
      let best: string | null = null;
      let bestScore = -Infinity;
      for (const k of remaining) {
        const score = (outdeg.get(k) as number) - (indeg.get(k) as number);
        if (score > bestScore) {
          best = k;
          bestScore = score;
        }
      }
      removeNode(best as string);
      head.push(best as string);
    }
  }
  const order = new Map([...head, ...tail].map((k, i) => [k, i]));

  // Longest path over forward feed edges only (backward edges are the
  // feedback arcs and place no layer constraint).
  const layer = new Map<string, number>();
  for (const k of [...keys].sort((a, b) => (order.get(a) as number) - (order.get(b) as number))) {
    let l = 0;
    for (const d of fedBy.get(k) as Set<string>) {
      if ((order.get(d) as number) < (order.get(k) as number)) {
        l = Math.max(l, (layer.get(d) ?? 0) + 1);
      }
    }
    layer.set(k, l);
  }

  const maxL = Math.max(...keys.map((k) => layer.get(k) ?? 0));
  const layers: string[][] = Array.from({ length: maxL + 1 }, () => []);
  for (const k of keys) layers[layer.get(k) ?? 0].push(k);

  // callers (reverse) index for the layer-0 refinement pass
  const callers = new Map<string, string[]>();
  for (const k of keys) {
    for (const d of deps.get(k) ?? []) {
      if (d === k) continue;
      const arr = callers.get(d) ?? [];
      arr.push(k);
      callers.set(d, arr);
    }
  }

  const pos = new Map<string, { x: number; y: number }>();
  layers[0].forEach((k, i) => pos.set(k, { x: i * PX, y: 0 }));

  const placeLower = (): void => {
    for (let l = 1; l <= maxL; l++) {
      const prov = layers[l].map((k) => {
        const xs = (deps.get(k) ?? [])
          .filter((d) => pos.has(d))
          .map((d) => (pos.get(d) as { x: number }).x);
        return { k, p: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0 };
      });
      prov.sort((a, b) => a.p - b.p);
      const xs = prov.map((p) => p.p);
      for (let i = 1; i < xs.length; i++) xs[i] = Math.max(xs[i], xs[i - 1] + PX);
      for (let i = xs.length - 2; i >= 0; i--) xs[i] = Math.min(xs[i], xs[i + 1] - PX);
      const meanP = prov.reduce((a, b) => a + b.p, 0) / (prov.length || 1);
      const meanX = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
      prov.forEach((p, i) => pos.set(p.k, { x: xs[i] + (meanP - meanX), y: l * PY }));
    }
  };
  placeLower();

  const targ0 = layers[0].map((k) => {
    const cs = (callers.get(k) ?? []).filter((c) => pos.has(c)).map((c) => (pos.get(c) as { x: number }).x);
    return { k, p: cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : (pos.get(k) as { x: number }).x };
  });
  targ0.sort((a, b) => a.p - b.p);
  targ0.forEach((t, i) => {
    const p = pos.get(t.k) as { x: number; y: number };
    pos.set(t.k, { x: i * PX, y: p.y });
  });
  placeLower();

  const xs = [...pos.values()].map((p) => p.x);
  const ys = [...pos.values()].map((p) => p.y);
  return {
    pos,
    bbox: {
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs) + GROUP_W,
      y1: Math.max(...ys) + GROUP_H,
    },
  };
}
