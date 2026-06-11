/**
 * Layered DAG layout from the design handoff: leaf dependencies (no outgoing
 * edges) at the TOP (layer 0), callers below, funneling down to the gateway.
 * Within a layer nodes sit at the mean x of their dependencies, with one
 * refinement pass re-ordering layer 0 by the mean x of its callers.
 * Cycle-safe: an edge that closes a cycle is ignored for layering.
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

  // Cycle-safe layer assignment.
  const keySet = new Set(keys);
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (key: string): number => {
    const cached = layer.get(key);
    if (cached != null) return cached;
    if (visiting.has(key)) return 0; // cycle: break here
    visiting.add(key);
    const ds = (deps.get(key) ?? []).filter((d) => d !== key && keySet.has(d));
    const l = ds.length ? 1 + Math.max(...ds.map(layerOf)) : 0;
    visiting.delete(key);
    layer.set(key, l);
    return l;
  };
  keys.forEach(layerOf);

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
