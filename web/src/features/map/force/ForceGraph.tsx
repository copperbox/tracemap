import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { buildGraph, type Graph, type GraphEdge, type GraphNode } from '../../../lib/grouping';
import { detectCommunities } from '../../../lib/community';
import { useStore } from '../../../state/store';
import { MapDrawer } from '../MapDrawer';
import { computeFocusSet } from '../view/focusSet';
import { buildDimmer } from '../view/dimming';
import { GraphModeToggle } from '../view/GraphModeToggle';
import { ZoomControls } from '../view/ZoomControls';
import { usePanZoom } from '../view/usePanZoom';
import { communityColor } from './colors';
import { ForceLegend } from './ForceLegend';
import { buildForceLinks, buildForceNodes } from './forceNodes';
import { useForceSimulation } from './useForceSimulation';
import styles from './ForceGraph.module.css';

const TAU = Math.PI * 2;
const LABEL_ZOOM = 0.9;

interface Palette {
  text: string;
  edge: string;
  warn: string;
  crit: string;
  accent: string;
}

/**
 * Force-directed "communities" view of the service graph: Obsidian-style dots
 * sized by traffic, colored by detected community, laid out by a d3-force
 * simulation and drawn on a single canvas so it scales to hundreds of nodes.
 * It shares the app's selection/focus/search/team-filter state, so clicking a
 * node opens the same drawer and dimming behaves the same as the layered map.
 */
export function ForceGraph() {
  const topology = useStore((s) => s.topology);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const focusId = useStore((s) => s.focusId);
  const setFocus = useStore((s) => s.setFocus);
  const search = useStore((s) => s.search);
  const teamFilter = useStore((s) => s.teamFilter);
  const theme = useStore((s) => s.theme);
  const graphType = useStore((s) => s.graphType);
  const setGraphType = useStore((s) => s.setGraphType);

  const canvasRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const sizeRef = useRef({ cssW: 0, cssH: 0 });
  const paletteRef = useRef<Palette>({
    text: '#e8eef8',
    // A SOLID muted gray (not the alpha-baked --edge): the canvas controls edge
    // opacity once via globalAlpha, so a pre-faded color would dim twice and
    // leave links nearly invisible.
    edge: '#5a6678',
    warn: '#fbbf24',
    crit: '#f87171',
    accent: '#4ade80',
  });

  const { tf, tfRef, dragging, beginPan, wasPan, zoomBy, fitBounds } = usePanZoom(canvasRef);

  // The communities view always works on the ungrouped service graph -- merging
  // teams into meganodes would defeat the topology-based community detection.
  const graph = useMemo<Graph>(
    () =>
      topology
        ? buildGraph(topology, { mergedTeams: [] })
        : { nodes: [] as GraphNode[], edges: [] as GraphEdge[], nodeKeyOf: (id: string) => id },
    [topology],
  );

  // Structural signature: communities + layout depend on structure only, so
  // metric-only polls don't recompute communities or reheat the simulation.
  const sig = useMemo(
    () =>
      [...graph.nodes.map((n) => n.key)].sort().join('|') +
      '#' +
      [...graph.edges.map((e) => e.key)].sort().join('|'),
    [graph],
  );

  const community = useMemo(
    () => detectCommunities(graph.nodes.map((n) => n.key), graph.edges),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- structure-only by design
    [sig],
  );

  // Node metadata (community, radius, status, label) refreshes every poll;
  // positions come from the simulation, which only rebuilds on structure change.
  const forceNodes = useMemo(() => buildForceNodes(graph.nodes, community.byNode), [graph, community]);
  const forceLinks = useMemo(() => buildForceLinks(graph.edges), [graph]);
  const metaByKey = useMemo(() => new Map(forceNodes.map((n) => [n.key, n])), [forceNodes]);

  const focus = useMemo(() => computeFocusSet(focusId, graph), [focusId, graph]);
  const dimmed = useMemo(
    () => buildDimmer(graph, { focus, query: search, teamFilter }),
    [graph, focus, search, teamFilter],
  );

  const [hover, setHover] = useState<string | null>(null);

  // ---- canvas drawing ----
  const drawRef = useRef<() => void>(() => {});
  const rafRef = useRef(0);
  const scheduleDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      drawRef.current();
    });
  }, []);

  const sim = useForceSimulation({
    nodes: forceNodes,
    links: forceLinks,
    sig,
    communityCount: community.count,
    onTick: scheduleDraw,
  });
  const simApiRef = useRef(sim);
  simApiRef.current = sim;

  const draw = (): void => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const { cssW, cssH } = sizeRef.current;
    ctx.clearRect(0, 0, cssW, cssH);
    const tfNow = tfRef.current;
    const k = tfNow.k;
    const pal = paletteRef.current;
    const nodes = sim.nodesRef.current;
    const posByKey = new Map(nodes.map((n) => [n.key, n]));
    const selEdgeKey = selection?.kind === 'edge' ? selection.id : null;
    const selNodeKey = selection?.kind === 'node' ? selection.id : null;
    const focusEdges = focus?.edges ?? null;

    // edges under the nodes
    ctx.lineCap = 'round';
    for (const l of forceLinks) {
      const s = posByKey.get(l.source);
      const t = posByKey.get(l.target);
      if (!s || !t) continue;
      const x1 = tfNow.tx + (s.x ?? 0) * k;
      const y1 = tfNow.ty + (s.y ?? 0) * k;
      const x2 = tfNow.tx + (t.x ?? 0) * k;
      const y2 = tfNow.ty + (t.y ?? 0) * k;
      if (Math.max(x1, x2) < -10 || Math.min(x1, x2) > cssW + 10) continue;
      if (Math.max(y1, y2) < -10 || Math.min(y1, y2) > cssH + 10) continue;
      const dimEdge = dimmed(l.source) || dimmed(l.target) || (focusEdges != null && !focusEdges.has(l.key));
      const lit =
        !dimEdge &&
        (l.key === selEdgeKey ||
          (hover != null && (l.source === hover || l.target === hover)) ||
          (selNodeKey != null && (l.source === selNodeKey || l.target === selNodeKey)));
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = lit ? pal.accent : pal.edge;
      ctx.globalAlpha = dimEdge ? 0.07 : lit ? 0.9 : 0.5;
      ctx.lineWidth = lit ? 2 : 1.2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // nodes
    for (const n of nodes) {
      const meta = metaByKey.get(n.key);
      if (!meta) continue;
      const sx = tfNow.tx + (n.x ?? 0) * k;
      const sy = tfNow.ty + (n.y ?? 0) * k;
      const r = Math.max(2, meta.r * k);
      if (sx < -r - 40 || sx > cssW + r + 40 || sy < -r - 40 || sy > cssH + r + 40) continue;
      const isDim = dimmed(n.key);
      const isSel = n.key === selNodeKey;
      const isHover = n.key === hover;

      ctx.globalAlpha = isDim ? 0.12 : 1;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, TAU);
      ctx.fillStyle = communityColor(meta.community, theme);
      ctx.fill();

      if (meta.isExternal) {
        ctx.setLineDash([2, 2]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = pal.text;
        ctx.globalAlpha = isDim ? 0.12 : 0.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (meta.status !== 'ok') {
        ctx.beginPath();
        ctx.arc(sx, sy, r + 1.5, 0, TAU);
        ctx.lineWidth = 2;
        ctx.strokeStyle = meta.status === 'crit' ? pal.crit : pal.warn;
        ctx.globalAlpha = isDim ? 0.12 : 1;
        ctx.stroke();
      }

      if (isSel || isHover) {
        ctx.beginPath();
        ctx.arc(sx, sy, r + (isSel ? 3 : 2), 0, TAU);
        ctx.lineWidth = isSel ? 2.4 : 1.6;
        ctx.strokeStyle = pal.accent;
        ctx.globalAlpha = isDim ? 0.3 : 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      if (!isDim && (isSel || isHover || k >= LABEL_ZOOM)) {
        ctx.font = '600 11px "Space Grotesk", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = pal.text;
        ctx.globalAlpha = isSel || isHover ? 1 : 0.85;
        ctx.fillText(meta.label, sx, sy + r + 3);
        ctx.globalAlpha = 1;
      }
    }
  };
  drawRef.current = draw;

  // Canvas context + DPR-aware sizing.
  useEffect(() => {
    const cv = surfaceRef.current;
    if (!cv) return;
    ctxRef.current = cv.getContext('2d');
    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      ctxRef.current?.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { cssW: w, cssH: h };
      scheduleDraw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [scheduleDraw]);

  // Theme colors for the canvas (CSS variables resolve to concrete values).
  useEffect(() => {
    const cs = getComputedStyle(document.body);
    paletteRef.current = {
      text: cs.getPropertyValue('--text').trim() || paletteRef.current.text,
      edge: cs.getPropertyValue('--faint').trim() || paletteRef.current.edge,
      warn: cs.getPropertyValue('--warn').trim() || paletteRef.current.warn,
      crit: cs.getPropertyValue('--crit').trim() || paletteRef.current.crit,
      accent: cs.getPropertyValue('--accent').trim() || paletteRef.current.accent,
    };
    scheduleDraw();
  }, [theme, scheduleDraw]);

  // Redraw on any state change (pan/zoom, hover, selection, metrics, ...).
  useEffect(() => {
    scheduleDraw();
  });

  // Cancel any pending frame on teardown AND clear the ref. Without the reset,
  // a cancelled-but-non-zero id would make scheduleDraw's guard permanently
  // short-circuit after a remount (e.g. React StrictMode's dev double-invoke),
  // so the canvas would never paint again.
  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    },
    [],
  );

  // Fit once per structural layout (the sim has settled by the time this runs).
  const fittedSigRef = useRef('');
  useEffect(() => {
    if (!graph.nodes.length || fittedSigRef.current === sig) return;
    const b = sim.bounds();
    if (!b) return;
    fittedSigRef.current = sig;
    fitBounds(b);
  }, [sig, graph, sim, fitBounds]);

  // ---- node dragging (world-space, reheats the simulation) ----
  const dragRef = useRef<{ moved: boolean; sx: number; sy: number } | null>(null);
  useEffect(() => {
    const toWorld = (clientX: number, clientY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const t = tfRef.current;
      if (!rect) return { x: 0, y: 0 };
      return { x: (clientX - rect.left - t.tx) / t.k, y: (clientY - rect.top - t.ty) / t.k };
    };
    const onMove = (e: MouseEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) d.moved = true;
      const w = toWorld(e.clientX, e.clientY);
      simApiRef.current.dragTo(w.x, w.y);
    };
    const onUp = (): void => {
      if (!dragRef.current) return;
      simApiRef.current.endDrag();
      setTimeout(() => {
        dragRef.current = null;
      }, 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [tfRef]);

  const worldAt = (e: ReactMouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const t = tfRef.current;
    if (!rect) return { x: 0, y: 0 };
    return { x: (e.clientX - rect.left - t.tx) / t.k, y: (e.clientY - rect.top - t.ty) / t.k };
  };

  const onMouseDown = (e: ReactMouseEvent): void => {
    if (e.button !== 0) return;
    const w = worldAt(e);
    const key = sim.pickNode(w.x, w.y);
    if (key) {
      e.stopPropagation();
      sim.startDrag(key, w.x, w.y);
      dragRef.current = { moved: false, sx: e.clientX, sy: e.clientY };
    } else {
      beginPan(e);
    }
  };

  const onMouseMove = (e: ReactMouseEvent): void => {
    if (dragRef.current || dragging) return;
    const w = worldAt(e);
    const key = sim.pickNode(w.x, w.y);
    setHover((prev) => (prev === key ? prev : key));
  };

  const onClick = (e: ReactMouseEvent): void => {
    if (wasPan() || dragRef.current?.moved) return;
    const w = worldAt(e);
    const key = sim.pickNode(w.x, w.y);
    if (key) select({ kind: 'node', id: key });
    else {
      select(null);
      setFocus(null);
    }
  };

  const onFit = (): void => {
    const b = sim.bounds();
    if (b) fitBounds(b);
  };

  return (
    <div className={styles.root}>
      <div
        ref={canvasRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHover(null)}
        onClick={onClick}
        className={[
          styles.canvas,
          dragging ? styles.canvasDragging : '',
          hover && !dragging ? styles.canvasHover : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{
          backgroundSize: `${22 * tf.k}px ${22 * tf.k}px`,
          backgroundPosition: `${tf.tx}px ${tf.ty}px`,
        }}
      >
        <canvas ref={surfaceRef} className={styles.surface} />
      </div>

      <GraphModeToggle value={graphType} shifted={selection != null} onChange={setGraphType} />
      <ForceLegend communityCount={community.count} />

      <ZoomControls
        shifted={selection != null}
        onZoomIn={() => zoomBy(1.3)}
        onZoomOut={() => zoomBy(1 / 1.3)}
        onFit={onFit}
        onResetLayout={() => sim.reheat(0.9)}
      />

      <MapDrawer graph={graph} onToggleMerge={() => {}} />
    </div>
  );
}
