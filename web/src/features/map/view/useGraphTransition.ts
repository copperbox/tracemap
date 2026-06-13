import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Graph } from '../../../lib/grouping';
import { computeGraphTransition, type GraphSnapshot, type GraphTransition, type Pos } from '../../../lib/transition';
import { ANIM_MS, easeOut } from './animation';

/**
 * ---- structural transition animation ----
 * When grouping/ungrouping (or any structure change) swaps the node set,
 * animate instead of snapping: survivors glide, revealed members fly out of
 * their old group, and collapsed members converge on it as fading ghosts.
 */
export function useGraphTransition(
  graph: Graph,
  layoutSig: string,
  posOf: (key: string) => Pos | undefined,
) {
  const [animT, setAnimT] = useState(1);
  const animRef = useRef<GraphTransition | null>(null);
  const animRafRef = useRef(0);
  const prevSnapRef = useRef<{ sig: string; snap: GraphSnapshot } | null>(null);

  const finishAnim = useCallback(() => {
    cancelAnimationFrame(animRafRef.current);
    animRef.current = null;
    setAnimT(1);
  }, []);

  const startAnim = useCallback((tr: GraphTransition) => {
    cancelAnimationFrame(animRafRef.current);
    animRef.current = tr;
    setAnimT(0);
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ANIM_MS);
      setAnimT(t);
      if (t < 1) animRafRef.current = requestAnimationFrame(step);
      else animRef.current = null;
    };
    animRafRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => () => cancelAnimationFrame(animRafRef.current), []);

  const eased = easeOut(animT);
  const animating = animT < 1 && animRef.current != null;

  /** Render position: the target, or mid-flight interpolation while animating. */
  const displayPos = useCallback(
    (key: string): Pos | undefined => {
      const target = posOf(key);
      if (!target) return undefined;
      const f = animT < 1 ? animRef.current?.from.get(key) : undefined;
      if (!f) return target;
      const e = easeOut(animT);
      return { x: f.x + (target.x - f.x) * e, y: f.y + (target.y - f.y) * e };
    },
    [posOf, animT],
  );

  // Snapshot what is on screen every render; when the structural signature
  // changes, diff the previous snapshot against the new targets and animate.
  useLayoutEffect(() => {
    const shown = new Map<string, Pos>();
    for (const n of graph.nodes) {
      const p = displayPos(n.key);
      if (p) shown.set(n.key, p);
    }
    const edgeKeys = new Set(graph.edges.map((e) => e.key));
    const prev = prevSnapRef.current;
    prevSnapRef.current = { sig: layoutSig, snap: { nodes: graph.nodes, pos: shown, edgeKeys } };
    if (prev && prev.sig !== layoutSig && prev.snap.nodes.length && graph.nodes.length) {
      const targets = new Map<string, Pos>();
      for (const n of graph.nodes) {
        const p = posOf(n.key);
        if (p) targets.set(n.key, p);
      }
      const tr = computeGraphTransition(prev.snap, { nodes: graph.nodes, pos: targets, edgeKeys });
      if (tr.from.size || tr.appear.size || tr.ghosts.length) startAnim(tr);
    }
  });

  return { animRef, animating, eased, displayPos, finishAnim };
}
