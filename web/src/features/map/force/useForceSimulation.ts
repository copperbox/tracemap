import { useEffect, useRef } from 'react';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { ViewBounds } from '../view/usePanZoom';
import { clusterForce } from './clusterForce';
import type { ForceLinkInput, ForceNodeInput } from './forceNodes';

/**
 * Owns the d3-force simulation behind the communities view. The simulation is
 * rebuilt only when the graph's STRUCTURE changes (the `sig`), warm-starting
 * surviving nodes from their last positions so the layout stays put across
 * metric polls. Settling runs a few ticks per animation frame within a time
 * budget, so even thousands of nodes never block the main thread; the canvas
 * repaints as it settles. Nodes start near their community's slot, so the
 * settle reads as clusters tightening, not an explosion from the origin. Once
 * settled it is left cooled until an interaction reheats it, so a large idle
 * graph costs no CPU. Dragging a node reheats and re-cools the layout.
 */

export interface SimNode extends SimulationNodeDatum {
  key: string;
  label: string;
  status: ForceNodeInput['status'];
  type: string;
  isExternal: boolean;
  community: number;
  r: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  key: string;
}

const SETTLE_TICKS = 200;
// Main-thread time spent ticking per frame while settling. One tick of a
// 5,000-node graph can exceed it on its own; at least one tick always runs.
const SETTLE_BUDGET_MS = 10;
const CHARGE = -190;
const LINK_DISTANCE = 64;
const CLUSTER_STRENGTH = 0.14;
const CENTER_STRENGTH = 0.035;

/** Deterministic [0,1) hash so new nodes get reproducible initial jitter. */
function hash01(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 1000;
}

export function useForceSimulation(opts: {
  nodes: ForceNodeInput[];
  links: ForceLinkInput[];
  sig: string;
  communityCount: number;
  onTick: () => void;
  /** Called once the initial settle finishes for a structure. */
  onSettled?: () => void;
}) {
  const { nodes, links, sig, communityCount } = opts;

  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const draggingRef = useRef<SimNode | null>(null);
  // Last known position per key, kept across rebuilds for warm starts.
  const posRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const onTickRef = useRef(opts.onTick);
  onTickRef.current = opts.onTick;
  const onSettledRef = useRef(opts.onSettled);
  onSettledRef.current = opts.onSettled;
  const settleRafRef = useRef(0);

  useEffect(() => {
    const prev = posRef.current;
    const ringR = 180 + communityCount * 26;

    const simNodes: SimNode[] = nodes.map((n) => {
      const warm = prev.get(n.key);
      if (warm) return { ...n, x: warm.x, y: warm.y };
      // Seed new nodes near their community's slot on a ring, with jitter, so
      // clusters start apart and the simulation only has to refine them.
      const ang = communityCount > 0 ? (2 * Math.PI * n.community) / communityCount : 0;
      const j = hash01(n.key);
      return {
        ...n,
        x: Math.cos(ang) * ringR + (j - 0.5) * 80,
        y: Math.sin(ang) * ringR + (hash01(n.key + 'y') - 0.5) * 80,
      };
    });
    const simLinks: SimLink[] = links.map((l) => ({ key: l.key, source: l.source, target: l.target }));

    const sim = forceSimulation<SimNode, SimLink>(simNodes)
      .force('charge', forceManyBody<SimNode>().strength(CHARGE))
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.key)
          .distance(LINK_DISTANCE)
          .strength(0.5),
      )
      .force('collide', forceCollide<SimNode>().radius((d) => d.r + 6).strength(0.85))
      .force('cluster', clusterForce(CLUSTER_STRENGTH))
      .force('x', forceX<SimNode>(0).strength(CENTER_STRENGTH))
      .force('y', forceY<SimNode>(0).strength(CENTER_STRENGTH))
      .stop();

    const savePositions = (): void => {
      const m = posRef.current;
      m.clear();
      for (const n of simNodes) m.set(n.key, { x: n.x ?? 0, y: n.y ?? 0 });
    };

    sim.on('tick', () => {
      savePositions();
      onTickRef.current();
    });

    simRef.current = sim;
    nodesRef.current = simNodes;
    onTickRef.current();

    // Settle in time-boxed slices, painting between them.
    let done = 0;
    const slice = (): void => {
      const t0 = performance.now();
      do {
        sim.tick();
        done++;
      } while (done < SETTLE_TICKS && performance.now() - t0 < SETTLE_BUDGET_MS);
      savePositions();
      onTickRef.current();
      if (done < SETTLE_TICKS) {
        settleRafRef.current = requestAnimationFrame(slice);
      } else {
        settleRafRef.current = 0;
        onSettledRef.current?.();
      }
    };
    settleRafRef.current = requestAnimationFrame(slice);

    return () => {
      cancelAnimationFrame(settleRafRef.current);
      settleRafRef.current = 0;
      sim.on('tick', null);
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild only on structural signature
  }, [sig]);

  const reheat = (alpha = 0.6): void => {
    stopSlicing();
    simRef.current?.alpha(alpha).restart();
  };

  const pickNode = (wx: number, wy: number): string | null => {
    let best: string | null = null;
    let bestD = Infinity;
    for (const n of nodesRef.current) {
      const dx = (n.x ?? 0) - wx;
      const dy = (n.y ?? 0) - wy;
      const d2 = dx * dx + dy * dy;
      const rr = (n.r + 4) * (n.r + 4);
      if (d2 <= rr && d2 < bestD) {
        best = n.key;
        bestD = d2;
      }
    }
    return best;
  };

  const bounds = (): ViewBounds | null => {
    const ns = nodesRef.current;
    if (!ns.length) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of ns) {
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      x0 = Math.min(x0, x - n.r);
      y0 = Math.min(y0, y - n.r);
      x1 = Math.max(x1, x + n.r);
      y1 = Math.max(y1, y + n.r);
    }
    return { x0, y0, x1, y1 };
  };

  /** Hand the rest of the settle to d3's own timer (an interaction took over). */
  const stopSlicing = (): void => {
    if (!settleRafRef.current) return;
    cancelAnimationFrame(settleRafRef.current);
    settleRafRef.current = 0;
  };

  const startDrag = (key: string, wx: number, wy: number): void => {
    const n = nodesRef.current.find((d) => d.key === key);
    if (!n) return;
    stopSlicing();
    draggingRef.current = n;
    n.fx = wx;
    n.fy = wy;
    simRef.current?.alphaTarget(0.3).restart();
  };

  const dragTo = (wx: number, wy: number): void => {
    const n = draggingRef.current;
    if (!n) return;
    n.fx = wx;
    n.fy = wy;
  };

  const endDrag = (): void => {
    const n = draggingRef.current;
    if (n) {
      n.fx = null;
      n.fy = null;
    }
    draggingRef.current = null;
    simRef.current?.alphaTarget(0);
  };

  /** True while the initial settle is still running. */
  const settling = (): boolean => settleRafRef.current !== 0;

  return { nodesRef, pickNode, bounds, reheat, startDrag, dragTo, endDrag, settling };
}
