import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useStore } from '../../state/store';
import { ARROW } from '../../lib/format';
import { LABEL_ZOOM_FACTOR } from '../../lib/preferences';
import { buildGraph, groupKey, type Graph, type GraphEdge, type GraphNode } from '../../lib/grouping';
import { GROUP_H, GROUP_W, NODE_H, NODE_W } from '../../lib/layout';
import { FRAME_TITLE_H, layoutClusteredGraph } from '../../lib/clusterLayout';
import {
  computeEdgeGeometryState,
  updateEdgeGeometryState,
  type EdgeGeometry,
  type EdgeInput,
  type GeometryState,
} from '../../lib/edgeGeometry';
import { NodeCard, NOOP_CARD_HANDLERS, type CardHandlers } from './NodeCard';
import { TeamFrameBar, type FrameHandlers } from './TeamFrame';
import { MapDrawer } from './MapDrawer';
import { EdgeLabelLayer, HoverEdgeLabel, edgeLabelText, wantsLabel } from './view/EdgeLabelLayer';
import { LABEL_BOX_H, labelBoxWidth, placeEdgeLabels } from './view/labelPlacement';
import { GraphModeToggle } from './view/GraphModeToggle';
import { Legend } from './view/Legend';
import { PacketCanvas } from './view/PacketCanvas';
import { TeamChips } from './view/TeamChips';
import { ZoomControls } from './view/ZoomControls';
import { buildEdgeViews, type EdgeView } from './view/edgeViews';
import { DOT_PITCH, dotAlphaScale, dotTilePx } from './view/dotGrid';
import { buildDimmer } from './view/dimming';
import { computeFocusSet } from './view/focusSet';
import { isolateGraph } from './view/isolateGraph';
import { IsolateBanner } from './view/IsolateBanner';
import { ZoomHint } from './view/ZoomHint';
import { LABEL_MIN_K, fitZoom } from './view/camera';
import { nodeCardBounds } from './view/nodeBounds';
import { buildFrameViews, type FrameView } from './view/frameViews';
import { clearPinnedPositions, loadPinnedPositions, type NodePositions } from './view/pinnedPositions';
import { useGraphTransition } from './view/useGraphTransition';
import { useMergeHandoff } from './view/useMergeHandoff';
import { useNodeDrag } from './view/useNodeDrag';
import { applyBackdrop, usePanZoom, type Transform } from './view/usePanZoom';
import { containsRect, needsRecull, rectsOverlap, shouldMount, visibleWorldRect, type WorldRect } from './view/viewport';
import { canvasLabelsOn, cardsCompact, chooseLod, type MapLod } from './view/lod';
import {
  FRAME_LABEL_PX,
  drawMap,
  drawOverlay,
  newMeshCache,
  readPalette,
  resetCanvasTextCache,
  type CanvasScene,
  type MapPalette,
  type MeshCache,
} from './view/mapCanvas';
import { hitEdge, hitRect, type RectItem } from './view/hitTest';
import { useEffectiveMergedTeams } from './view/autoCollapse';
import { mapSummary } from './view/mapSummary';
import { usePixelRatio } from './view/pixelRatio';
import { layoutSignature, type LayoutSigState } from './view/layoutSignature';
import styles from './MapView.module.css';

// Screen-pixel buffer kept around the viewport when choosing which cards to
// mount: a pan within it costs no React render, and leaving it re-mounts.
const CULL_PAD_PX = 140;

// Pointer tolerance for edges, in screen px (converted to world units per zoom).
const EDGE_HIT_PX = 6;

// A camera that has not moved for this long is at rest: the map is redrawn
// once more at full quality (see MeshCache).
const SETTLE_MS = 140;

// Drawer width (keep in step with MapDrawer.module.css .drawer width). The
// selection auto-center reserves it so the chosen node lands clear of the drawer.
const DRAWER_W = 352;

const EMPTY_GRAPH: Graph = { nodes: [], edges: [], nodeKeyOf: (id: string) => id };

const widthOf = (n: GraphNode) => (n.kind === 'group' ? GROUP_W : NODE_W);
const heightOf = (n: GraphNode) => (n.kind === 'group' ? GROUP_H : NODE_H);

/** What the mounted DOM layer was last built for. */
interface ViewState {
  rect: WorldRect;
  k: number;
  lod: MapLod;
  compact: boolean;
  canvasLabels: boolean;
}

type Hit = { kind: 'node'; node: GraphNode } | { kind: 'frame'; frame: FrameView } | { kind: 'edge'; key: string };

/** Layered dependency-flow view of the service map (the default graph type). */
export function LayeredMap() {
  const topology = useStore((s) => s.topology);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const setHoverEdge = useStore((s) => s.setHoverEdge);
  const focusId = useStore((s) => s.focusId);
  const setFocus = useStore((s) => s.setFocus);
  const isolateId = useStore((s) => s.isolateId);
  const setIsolate = useStore((s) => s.setIsolate);
  const search = useStore((s) => s.search);
  const teamFilter = useStore((s) => s.teamFilter);
  const setTeamFilter = useStore((s) => s.setTeamFilter);
  const storeMergedTeams = useStore((s) => s.mergedTeams);
  const toggleTeamMerged = useStore((s) => s.toggleTeamMerged);
  const setMergedTeams = useStore((s) => s.setMergedTeams);
  const navigate = useStore((s) => s.navigate);
  const graphType = useStore((s) => s.graphType);
  const setGraphType = useStore((s) => s.setGraphType);
  const labelZoom = useStore((s) => s.labelZoom);
  const teamGrouping = useStore((s) => s.teamGrouping);
  const theme = useStore((s) => s.theme);

  // Effective label threshold: the tuned default scaled by the user preference
  // ('always' zeroes it out, so labels never hide).
  const labelMinK = LABEL_MIN_K * LABEL_ZOOM_FACTOR[labelZoom];

  const canvasRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLCanvasElement>(null);
  const { tfRef, subscribe, isDragging, beginPan, wasPan, zoomBy, fitBounds, centerOn, panBy } = usePanZoom(
    canvasRef,
    styles.canvasDragging,
  );

  // Canvas size in CSS px. Defaults to the window so the first paint (before
  // the observer fires) errs toward mounting more rather than less.
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = (): void => setViewport({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // User-pinned node positions (dragging a node overrides the auto-layout;
  // "fit" resets). Edges always follow the effective position. A drag moves
  // one node, or every member of a team when grabbed by its frame.
  const [pinned, setPinned] = useState<NodePositions>(loadPinnedPositions);
  const { beginDrag, wasNodeDrag, draggedKeys } = useNodeDrag(tfRef, setPinned);

  // Large fleets start with teams collapsed; a selected or isolated service
  // inside a collapsed team expands it.
  const mergedTeams = useEffectiveMergedTeams({
    topology,
    mergedTeams: storeMergedTeams,
    setMergedTeams,
    selection,
    isolateId,
    teamFilter,
  });

  // Unchanged services and edges keep their graph objects between frames, so
  // memoized cards skip everything that did not change.
  const prevGraphRef = useRef<Graph | null>(null);
  const fullGraph = useMemo(() => {
    const g = topology
      ? buildGraph(topology, { mergedTeams, teamGrouping, prev: prevGraphRef.current })
      : EMPTY_GRAPH;
    prevGraphRef.current = g;
    return g;
  }, [topology, mergedTeams, teamGrouping]);

  // Isolation prunes the graph to one dependency tree BEFORE layout, so the
  // whole pipeline (layout, culling, edges, drawer) only ever sees the subtree.
  // Returns the same reference when nothing is isolated, so `isolated` below is
  // a cheap identity check.
  const graph = useMemo(() => isolateGraph(fullGraph, isolateId), [fullGraph, isolateId]);
  const isolated = graph !== fullGraph;

  // Human label for the isolated entity (node, team group, or "src -> tgt"
  // edge), drawn from the full graph so the name survives the pruning.
  const isolateLabel = useMemo(() => {
    if (!isolated || !isolateId) return null;
    const nameOf = (key: string) => fullGraph.nodes.find((n) => n.key === key)?.label ?? key;
    if (isolateId.includes('=>')) {
      const [src, tgt] = isolateId.split('=>');
      return `${nameOf(src)} ${ARROW} ${nameOf(tgt)}`;
    }
    return nameOf(isolateId);
  }, [isolated, isolateId, fullGraph]);

  // The layout must only depend on the graph's STRUCTURE (ids, team
  // membership, node sizes). Metrics refresh every frame, so the memo is keyed
  // on a structural signature.
  const sigRef = useRef<LayoutSigState | null>(null);
  const layoutSig = useMemo(() => {
    sigRef.current = layoutSignature(sigRef.current, graph.nodes, graph.edges, teamGrouping);
    return sigRef.current.sig;
  }, [graph, teamGrouping]);

  // Layout results cached by signature, so returning to a structure already
  // seen (the full graph, on isolate exit) is instant. Bounded so a long
  // session of merges/isolations stays small.
  const layoutCache = useRef(new Map<string, ReturnType<typeof layoutClusteredGraph>>());
  const layout = useMemo(() => {
    const cache = layoutCache.current;
    const cached = cache.get(layoutSig);
    if (cached) return cached;
    const result = layoutClusteredGraph(graph.nodes, graph.edges, { teamGrouping });
    cache.set(layoutSig, result);
    if (cache.size > 32) cache.delete(cache.keys().next().value as string);
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- structure-only dependency by design
  }, [layoutSig]);

  const fitView = useCallback(
    (resetPinned = false) => {
      if (!layout.pos.size) return;
      if (resetPinned) {
        setPinned({});
        clearPinnedPositions();
      }
      fitBounds(layout.bbox);
    },
    [layout, fitBounds],
  );

  /** Effective node position: user-pinned override wins over auto-layout. */
  const posOf = useCallback(
    (key: string): { x: number; y: number } | undefined => pinned[key] ?? layout.pos.get(key),
    [pinned, layout],
  );

  const toggleMergeInPlace = useMergeHandoff({
    graph,
    layout,
    pinned,
    mergedTeams,
    posOf,
    setPinned,
    toggleTeamMerged,
  });

  // A large layout is packed in rows, so expanding or collapsing one team
  // reflows the clusters after it. Keep the toggled team where it was on
  // screen: remember its top-left, and pan by however far the layout moved it.
  const anchorRef = useRef<{ teamId: number; x: number; y: number } | null>(null);
  const teamBounds = (teamId: number) =>
    nodeCardBounds(graph.nodes.filter((n) => n.teamId === teamId).map((n) => posOf(n.key)));
  const toggleMerge = (teamId: number): void => {
    const b = teamBounds(teamId);
    anchorRef.current = b ? { teamId, x: b.x0, y: b.y0 } : null;
    toggleMergeInPlace(teamId);
  };
  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (!a) return;
    anchorRef.current = null;
    const b = teamBounds(a.teamId);
    if (!b) return;
    const k = tfRef.current.k;
    if (b.x0 !== a.x || b.y0 !== a.y) panBy((a.x - b.x0) * k, (a.y - b.y0) * k);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per new layout
  }, [layout]);

  const { animRef, animating, eased, displayPos, finishAnim } = useGraphTransition(graph, layoutSig, posOf);

  // Fit on first data, and after the merge-all/unmerge-all shortcut (whose
  // graph change is too big to stay oriented without one). Individual team
  // toggles deliberately do NOT re-fit: they expand/collapse in place.
  // A layout effect, so the new graph is never painted at the old camera.
  const fittedRef = useRef(false);
  const fitPendingRef = useRef(false);
  useLayoutEffect(() => {
    if (!graph.nodes.length) return;
    if (!fittedRef.current || fitPendingRef.current) {
      fittedRef.current = true;
      fitPendingRef.current = false;
      fitView();
    }
  }, [graph, fitView]);

  // "Merge all" with no team that owns a service changes nothing: the graph
  // is the same object, so the fit above does not run. Put back the view the
  // click set aside, and drop the pending fit so a later metrics update does
  // not reframe the map. Declared after the fit: it runs in the same commit.
  const mergeAllFromRef = useRef<{ view: ViewState | null } | null>(null);
  useLayoutEffect(() => {
    const from = mergeAllFromRef.current;
    if (!from) return;
    mergeAllFromRef.current = null;
    if (!fitPendingRef.current) return;
    fitPendingRef.current = false;
    setView(from.view);
  });

  // Entering or leaving isolation reframes the map onto the new layout. Skips
  // the initial mount so a deep-linked isolated load uses the first-data fit.
  const prevIsolateRef = useRef(isolateId);
  useEffect(() => {
    if (prevIsolateRef.current === isolateId) return;
    prevIsolateRef.current = isolateId;
    fitView();
  }, [isolateId, fitView]);

  // Toggling team grouping swaps the layout algorithm, a wholesale re-flow of
  // the whole map: reframe onto it. Skips the initial mount.
  const prevGroupingRef = useRef(teamGrouping);
  useEffect(() => {
    if (prevGroupingRef.current === teamGrouping) return;
    prevGroupingRef.current = teamGrouping;
    fitView();
  }, [teamGrouping, fitView]);

  // Drop a stale isolate id (e.g. a deep link to a service that no longer
  // exists) so the URL and map agree. Guard on a loaded graph: before data
  // arrives isolateGraph also returns the full (empty) graph.
  useEffect(() => {
    if (isolateId && fullGraph.nodes.length && graph === fullGraph) setIsolate(null);
  }, [isolateId, fullGraph, graph, setIsolate]);

  const wasDrag = useCallback(() => wasPan() || wasNodeDrag(), [wasPan, wasNodeDrag]);

  // ---- dimming (focus, search, team filter) ----
  const focus = useMemo(() => computeFocusSet(focusId, graph), [focusId, graph]);
  const dimmed = useMemo(
    () => buildDimmer(graph, { focus, query: search, teamFilter }),
    [graph, focus, search, teamFilter],
  );

  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.key, n])), [graph]);

  const selEdgeKey = selection?.kind === 'edge' ? selection.id : null;
  const selNodeKey =
    selection?.kind === 'node' ? selection.id : selection?.kind === 'group' ? groupKey(selection.teamId) : null;

  // Zoom the camera onto the focus cone when Focus is switched on, and back to
  // the full layout when it's cleared. Guarded on focusId so a metrics frame
  // (which changes posOf/focus) never re-runs the fit.
  const prevFocusRef = useRef(focusId);
  useEffect(() => {
    if (prevFocusRef.current === focusId) return;
    prevFocusRef.current = focusId;
    if (!focusId) {
      fitView(); // clearing focus returns to the full overview
      return;
    }
    if (!focus) return;
    const box = nodeCardBounds([...focus.nodes].map((k) => posOf(k)));
    if (!box) return;
    // If the whole cone fits at a readable zoom, frame it; otherwise keep the
    // focused node centered and legible (its cone stays highlighted).
    if (fitZoom(box, viewport.w, viewport.h) >= labelMinK) {
      fitBounds(box);
      return;
    }
    const seedKey = focusId.includes('=>') ? focusId.split('=>')[0] : focusId;
    const seed = nodeById.get(seedKey);
    const sp = posOf(seedKey);
    if (seed && sp) {
      centerOn({ x0: sp.x, y0: sp.y, x1: sp.x + widthOf(seed), y1: sp.y + heightOf(seed) }, { rightInset: DRAWER_W });
    } else {
      fitBounds(box);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reframe once per focus change; posOf/nodeById churn each frame
  }, [focusId, fitView, fitBounds, centerOn, viewport]);

  // Bring a freshly selected node/group to the centre of the visible map (clear
  // of the drawer) at a legible zoom. Keyed on the selected key so it fires
  // once per selection, not on every frame. Edge selections are left alone.
  const prevSelRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selNodeKey) {
      prevSelRef.current = null;
      return;
    }
    if (prevSelRef.current === selNodeKey) return;
    const n = nodeById.get(selNodeKey);
    const p = posOf(selNodeKey);
    if (!n || !p) return;
    prevSelRef.current = selNodeKey;
    centerOn({ x0: p.x, y0: p.y, x1: p.x + widthOf(n), y1: p.y + heightOf(n) }, { rightInset: DRAWER_W });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- center once per selection; posOf/nodeById churn each frame
  }, [selNodeKey, centerOn, nodeById]);

  // ---- edge geometry + views ----
  // Anchor sides come from the nodes' actual relative positions. The path runs
  // dependency -> dependent so packets flow INTO the dependent, where the
  // arrowhead sits. Geometry depends on structure and positions only, so a
  // metrics frame reuses it.
  const edgeInputs = useMemo<EdgeInput[]>(
    () => graph.edges.map((e) => ({ key: e.key, fromKey: e.targetKey, toKey: e.sourceKey })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- edge keys are fixed for a structure
    [layoutSig],
  );
  // While a drag only moves pinned nodes, rebuild just the edges around them.
  const geomRef = useRef<{ sig: string; layout: unknown; pinned: NodePositions; state: GeometryState } | null>(null);
  const geomCache = useRef(new Map<string, { layout: unknown; pinned: NodePositions; state: GeometryState }>());
  const geoms = useMemo(() => {
    const rectOf = (key: string) => {
      const p = displayPos(key);
      const n = nodeById.get(key);
      return p && n ? { x: p.x, y: p.y, w: widthOf(n), h: heightOf(n) } : undefined;
    };
    const prev = geomRef.current;
    let state: GeometryState | null = null;
    // A structure seen before with the same pins (merge all, then unmerge all
    // again) reuses its geometry outright.
    const cached = animating ? undefined : geomCache.current.get(layoutSig);
    if (cached && cached.layout === layout && cached.pinned === pinned) state = cached.state;
    else if (prev && prev.sig === layoutSig && prev.layout === layout && !animating && prev.pinned !== pinned) {
      const moved = new Set<string>();
      for (const k of Object.keys(pinned)) if (pinned[k] !== prev.pinned[k]) moved.add(k);
      for (const k of Object.keys(prev.pinned)) if (!(k in pinned)) moved.add(k);
      if (moved.size <= 64) state = updateEdgeGeometryState(prev.state, edgeInputs, rectOf, moved);
    }
    state ??= computeEdgeGeometryState(edgeInputs, rectOf);
    geomRef.current = { sig: layoutSig, layout, pinned, state };
    if (!animating) {
      const cache = geomCache.current;
      cache.delete(layoutSig);
      cache.set(layoutSig, { layout, pinned, state });
      if (cache.size > 4) cache.delete(cache.keys().next().value as string);
    }
    return state.geoms;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on structure + positions by design
  }, [layoutSig, displayPos]);
  const edgeViewsRef = useRef<EdgeView[]>([]);
  const edgeViews = useMemo(
    () => {
      edgeViewsRef.current = buildEdgeViews(
        graph.edges,
        geoms,
        {
          dimmed,
          focusEdges: focus?.edges ?? null,
          selEdgeKey,
          fadeInOf: (key) => (animating && animRef.current?.newEdges.has(key) ? eased : 1),
        },
        edgeViewsRef.current,
      );
      return edgeViewsRef.current;
    },
    [graph.edges, geoms, dimmed, focus, selEdgeKey, animating, eased, animRef],
  );

  const teams = useMemo(() => topology?.teams ?? [], [topology?.teams]);
  const allMerged = teams.length > 0 && teams.every((t) => mergedTeams.includes(t.id));

  // Ownership frames are the visual half of team grouping; with grouping off
  // the map draws bare service cards (each labelled with its team) and no frames.
  const frameViews = useMemo(
    () => (teamGrouping ? buildFrameViews(teams, graph.nodes, displayPos, dimmed) : []),
    [teamGrouping, teams, graph.nodes, displayPos, dimmed],
  );

  // ---- level of detail + culling window ----
  // React state changes only when the level of detail, the label mode, or the
  // mounted window changes; every other camera move is applied imperatively.
  const [view, setView] = useState<ViewState | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const lod: MapLod = view?.lod ?? 'canvas';

  // ---- canvas drawing ----
  // Two canvases: the map (frames, edges, overview nodes) and an overlay for
  // the hovered and selected edge or node. Pointer handlers draw the overlay
  // directly from refs, so a hover neither renders React nor redraws the map.
  const paletteRef = useRef<MapPalette | null>(null);
  const sceneRef = useRef<Omit<CanvasScene, 'labels' | 'moving'> | null>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const overlayShownRef = useRef(false);
  const hoverNodeRef = useRef<string | null>(null);
  const hoverEdgeRef = useRef<string | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const meshRef = useRef<MeshCache | null>(null);
  const movingRef = useRef(false);
  const highlightRef = useRef({ selEdgeKey, selNodeKey, nodeById });
  // What the canvases draw is set when a render commits, not while it runs.
  // Card mounting renders as a transition, in slices across several frames;
  // a camera frame drawn in between must still see the committed scene, or
  // the canvas would drop its nodes before their cards exist.
  useLayoutEffect(() => {
    sceneRef.current = {
      drawNodes: lod === 'canvas',
      frameTitles: lod === 'canvas',
      nodes: graph.nodes,
      posOf: displayPos,
      dimmed,
      frames: frameViews,
      edges: edgeViews,
      geomKey: geoms,
    };
    highlightRef.current = { selEdgeKey, selNodeKey, nodeById };
  });

  const drawOverlayNow = useCallback(() => {
    const cv = overlayRef.current;
    const scene = sceneRef.current;
    if (!cv || !scene) return;
    const hide = (): void => {
      if (!overlayShownRef.current) return;
      overlayShownRef.current = false;
      cv.style.display = 'none';
    };
    const hi = highlightRef.current;
    // node highlights are the canvas's job only while it draws the nodes
    const hoverNodeKey = scene.drawNodes ? hoverNodeRef.current : null;
    const selNodeKey = scene.drawNodes ? hi.selNodeKey : null;
    if (!hoverEdgeRef.current && !hi.selEdgeKey && !hoverNodeKey && !selNodeKey) return hide();
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const { w, h, dpr } = sizeRef.current;
    // the backing store is only allocated once something is highlighted
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (cv.width !== pw || cv.height !== ph) {
      cv.width = pw;
      cv.height = ph;
    }
    paletteRef.current ??= readPalette();
    const edgeOf = (key: string | null): EdgeView | null =>
      key ? (scene.edges.find((v) => v.e.key === key) ?? null) : null;
    const tf = tfRef.current;
    const drawn = drawOverlay(
      ctx,
      {
        hoverEdge: edgeOf(hoverEdgeRef.current),
        selEdge: edgeOf(hi.selEdgeKey),
        hoverNode: (hoverNodeKey && hi.nodeById.get(hoverNodeKey)) || null,
        selNode: (selNodeKey && hi.nodeById.get(selNodeKey)) || null,
        posOf: scene.posOf,
        dimmed: scene.dimmed,
      },
      tf,
      w,
      h,
      dpr,
      paletteRef.current,
      canvasLabelsOn(tf.k, labelMinKRef.current, isolatedRef.current),
    );
    if (!drawn) return hide();
    if (!overlayShownRef.current) {
      overlayShownRef.current = true;
      cv.style.display = 'block';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads refs only
  }, []);

  // What the map canvas last drew, so a render that changed nothing it shows
  // (a new cull window, a drag starting) does not repaint thousands of edges.
  const drawnRef = useRef<{
    scene: Omit<CanvasScene, 'labels' | 'moving'>;
    tf: Transform;
    w: number;
    h: number;
    dpr: number;
    pal: MapPalette;
    labels: boolean;
    meshStale: boolean;
  } | null>(null);
  const drawNow = useCallback(() => {
    const cv = surfaceRef.current;
    const ctx = cv?.getContext('2d');
    const scene = sceneRef.current;
    if (!cv || !ctx || !scene) return;
    const pal = (paletteRef.current ??= readPalette());
    const tf = tfRef.current;
    const { w, h, dpr } = sizeRef.current;
    const labels = canvasLabelsOn(tf.k, labelMinKRef.current, isolatedRef.current);
    const moving = movingRef.current;
    const d = drawnRef.current;
    const unchanged =
      d != null &&
      d.tf === tf &&
      d.w === w &&
      d.h === h &&
      d.dpr === dpr &&
      d.pal === pal &&
      d.labels === labels &&
      d.scene.nodes === scene.nodes &&
      d.scene.edges === scene.edges &&
      d.scene.geomKey === scene.geomKey &&
      d.scene.frames === scene.frames &&
      d.scene.posOf === scene.posOf &&
      d.scene.dimmed === scene.dimmed &&
      d.scene.drawNodes === scene.drawNodes &&
      d.scene.frameTitles === scene.frameTitles &&
      // a mesh drawn from a drifted bitmap is redrawn once the camera rests
      !(d.meshStale && !moving);
    if (!unchanged) {
      const res = drawMap(ctx, { ...scene, labels, moving }, tf, w, h, dpr, pal, (meshRef.current ??= newMeshCache()));
      drawnRef.current = { scene, tf, w, h, dpr, pal, labels, meshStale: res.meshStale };
    }
    drawOverlayNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads refs only
  }, [drawOverlayNow]);
  const labelMinKRef = useRef(labelMinK);
  labelMinKRef.current = labelMinK;
  const isolatedRef = useRef(isolated);
  isolatedRef.current = isolated;

  const rafRef = useRef(0);
  const scheduleDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      drawNow();
    });
  }, [drawNow]);
  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    },
    [],
  );

  // Every committed render repaints synchronously, before the browser paints,
  // so a level-of-detail switch swaps canvas nodes for cards in one frame.
  const markedRef = useRef(false);
  useLayoutEffect(() => {
    drawNow();
    // one user-timing mark for the first frame with data, so time to first
    // usable map can be measured from outside (scale checks, devtools)
    if (!markedRef.current && graph.nodes.length && viewRef.current) {
      markedRef.current = true;
      performance.mark('tracemap:map-first-draw');
    }
  });

  // Canvas backing store follows the element size and the device pixel ratio
  // (which changes when the window moves to another display).
  const dpr = usePixelRatio();
  useLayoutEffect(() => {
    const cv = surfaceRef.current;
    if (!cv) return;
    cv.width = Math.max(1, Math.round(viewport.w * dpr));
    cv.height = Math.max(1, Math.round(viewport.h * dpr));
    sizeRef.current = { w: viewport.w, h: viewport.h, dpr };
    drawnRef.current = null; // setting the size cleared the canvas
    drawNow();
  }, [viewport, dpr, drawNow]);

  // Theme colors (CSS variables) resolve into the canvas palette.
  useLayoutEffect(() => {
    paletteRef.current = readPalette();
    drawNow();
  }, [theme, drawNow]);

  // Web fonts arriving late would leave canvas text in the fallback face.
  useEffect(() => {
    void document.fonts?.ready.then(() => {
      resetCanvasTextCache();
      drawnRef.current = null;
      scheduleDraw();
    });
  }, [scheduleDraw]);

  // The camera subscriber: move the DOM world and the backdrop, repaint the
  // canvas on the next frame, and re-render React only on a LOD/window change.
  const nodeCount = graph.nodes.length;
  const settleRef = useRef(0);
  useEffect(() => () => window.clearTimeout(settleRef.current), []);
  useEffect(() => {
    const onCamera = (tf: Transform): void => {
      const world = worldRef.current;
      if (world) world.style.transform = `translate(${tf.tx}px, ${tf.ty}px) scale(${tf.k})`;
      const el = canvasRef.current;
      if (el) {
        const tile = dotTilePx(tf.k);
        applyBackdrop(el, tf, tile, dotAlphaScale(tile / DOT_PITCH));
      }
      movingRef.current = true;
      window.clearTimeout(settleRef.current);
      settleRef.current = window.setTimeout(() => {
        movingRef.current = false;
        scheduleDraw();
      }, SETTLE_MS);
      scheduleDraw();

      const cur = viewRef.current;
      const nextLod = chooseLod(tf.k, nodeCount, cur?.lod ?? 'canvas');
      const compact = cardsCompact(tf.k, labelMinK, isolated);
      const canvasLabels = canvasLabelsOn(tf.k, labelMinK, isolated);
      const visible = visibleWorldRect(tf, viewport.w, viewport.h, 0);
      const changed =
        !cur ||
        cur.lod !== nextLod ||
        cur.compact !== compact ||
        cur.canvasLabels !== canvasLabels ||
        (nextLod === 'cards' && needsRecull(cur, visible, tf.k));
      if (!changed) return;
      const next: ViewState = {
        rect: visibleWorldRect(tf, viewport.w, viewport.h, CULL_PAD_PX),
        k: tf.k,
        lod: nextLod,
        compact,
        canvasLabels,
      };
      viewRef.current = next;
      // Mounting the cards for a new window is not urgent: as a transition
      // React renders them in slices between frames, so a zoom that brings
      // two hundred cards on screen does not stall the camera. Dropping to
      // the canvas only unmounts, and happens at once.
      if (nextLod === 'canvas') setView(next);
      else startTransition(() => setView(next));
    };
    onCamera(tfRef.current);
    return subscribe(onCamera);
  }, [subscribe, tfRef, scheduleDraw, viewport, nodeCount, labelMinK, isolated]);

  // ---- hit-testing (canvas level of detail, and edges at every level) ----
  // Built lazily on the first pointer query after a change, so a drag or a
  // metrics frame does not pay for them.
  const hitCacheRef = useRef<{ nodes: unknown; pos: unknown; rects: RectItem[] } | null>(null);
  const nodeRects = (): RectItem[] => {
    const c = hitCacheRef.current;
    if (c && c.nodes === graph.nodes && c.pos === displayPos) return c.rects;
    const rects: RectItem[] = [];
    for (const n of graph.nodes) {
      const p = displayPos(n.key);
      if (p) rects.push({ key: n.key, rect: { x0: p.x, y0: p.y, x1: p.x + widthOf(n), y1: p.y + heightOf(n) } });
    }
    hitCacheRef.current = { nodes: graph.nodes, pos: displayPos, rects };
    return rects;
  };
  const curveCacheRef = useRef<{ geoms: unknown; curves: { key: string; curve: EdgeGeometry['curve'] }[] } | null>(null);
  const edgeCurves = (): { key: string; curve: EdgeGeometry['curve'] }[] => {
    const c = curveCacheRef.current;
    if (c && c.geoms === geoms) return c.curves;
    const curves = [...geoms].map(([key, g]) => ({ key, curve: g.curve }));
    curveCacheRef.current = { geoms, curves };
    return curves;
  };

  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = canvasRef.current?.getBoundingClientRect();
    const t = tfRef.current;
    if (!r) return { x: 0, y: 0 };
    return { x: (clientX - r.left - t.tx) / t.k, y: (clientY - r.top - t.ty) / t.k };
  };

  /** Pointer targets owned by the canvas, not by a DOM card or bar. */
  const onBackground = (target: EventTarget): boolean =>
    target === canvasRef.current || target === surfaceRef.current || target === worldRef.current;

  const pick = (clientX: number, clientY: number): Hit | null => {
    const { x, y } = toWorld(clientX, clientY);
    const k = tfRef.current.k;
    if (lod === 'canvas') {
      const key = hitRect(nodeRects(), x, y, 2 / k);
      const node = key ? nodeById.get(key) : undefined;
      if (node) return { kind: 'node', node };
      // the team name above the frame, or the frame's own title band
      const frame = frameViews.find(
        (f) => x >= f.x && x <= f.x + f.w && y >= f.y - (FRAME_LABEL_PX + 6) / k && y <= f.y + FRAME_TITLE_H,
      );
      if (frame) return { kind: 'frame', frame };
    }
    const edge = hitEdge(edgeCurves(), x, y, EDGE_HIT_PX / k);
    return edge ? { kind: 'edge', key: edge } : null;
  };

  const startNodeDrag = (e: ReactMouseEvent, node: GraphNode): void => {
    finishAnim();
    const tp = posOf(node.key) ?? displayPos(node.key) ?? { x: 0, y: 0 };
    beginDrag(e, [{ key: node.key, origX: tp.x, origY: tp.y }]);
  };
  const startFrameDrag = (e: ReactMouseEvent, memberKeys: string[]): void => {
    finishAnim();
    beginDrag(
      e,
      memberKeys.map((k) => {
        const p = posOf(k) ?? { x: 0, y: 0 };
        return { key: k, origX: p.x, origY: p.y };
      }),
    );
  };
  const selectNode = (n: GraphNode): void =>
    select(n.kind === 'group' ? { kind: 'group', teamId: n.teamId as number } : { kind: 'node', id: n.key });
  const openNode = (n: GraphNode): void => {
    if (n.kind === 'group') toggleMerge(n.teamId as number);
    else navigate('service', n.key);
  };

  // Stable handler objects so memoized cards and bars never re-render just
  // because this component did.
  const handlersRef = useRef<{ card: CardHandlers; frame: FrameHandlers } | null>(null);
  handlersRef.current = {
    card: {
      click: (ev, n) => {
        ev.stopPropagation();
        if (wasDrag()) return;
        selectNode(n);
      },
      open: openNode,
      toggleGroup: (n) => toggleMerge(n.teamId as number),
      dragStart: (ev, n) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        startNodeDrag(ev, n);
      },
      activate: selectNode,
    },
    frame: {
      merge: (teamId) => toggleMerge(teamId),
      dragStart: (ev, teamId) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        const f = frameViews.find((x) => x.teamId === teamId);
        if (f) startFrameDrag(ev, f.memberKeys);
      },
    },
  };
  const drawerToggleMerge = useCallback((teamId: number) => handlersRef.current?.frame.merge(teamId), []);
  const cardHandlers = useMemo<CardHandlers>(
    () => ({
      click: (e, n) => handlersRef.current?.card.click(e, n),
      open: (n) => handlersRef.current?.card.open(n),
      toggleGroup: (n) => handlersRef.current?.card.toggleGroup(n),
      dragStart: (e, n) => handlersRef.current?.card.dragStart(e, n),
      activate: (n) => handlersRef.current?.card.activate(n),
    }),
    [],
  );
  const frameHandlers = useMemo<FrameHandlers>(
    () => ({
      merge: (t) => handlersRef.current?.frame.merge(t),
      dragStart: (e, t) => handlersRef.current?.frame.dragStart(e, t),
    }),
    [],
  );

  // ---- pointer on the canvas ----
  const setHoverClass = (on: boolean): void => {
    canvasRef.current?.classList.toggle(styles.canvasHover, on);
  };
  const hoverRafRef = useRef(0);
  const hoverEvRef = useRef<{ x: number; y: number; target: EventTarget } | null>(null);
  const hoverRef = useRef<() => void>(() => {});
  hoverRef.current = () => {
    const ev = hoverEvRef.current;
    if (!ev) return;
    const hit = onBackground(ev.target) ? pick(ev.x, ev.y) : null;
    const nodeKey = hit?.kind === 'node' ? hit.node.key : null;
    const edgeKey = hit?.kind === 'edge' ? hit.key : null;
    if (hoverNodeRef.current !== nodeKey || hoverEdgeRef.current !== edgeKey) {
      hoverNodeRef.current = nodeKey;
      hoverEdgeRef.current = edgeKey;
      drawOverlayNow();
    }
    // only the hovered edge's label subscribes to this
    if (useStore.getState().hoverEdge !== edgeKey) setHoverEdge(edgeKey);
    setHoverClass(hit != null);
  };
  const onMouseMove = (e: ReactMouseEvent): void => {
    if (isDragging() || wasNodeDrag()) return;
    hoverEvRef.current = { x: e.clientX, y: e.clientY, target: e.target };
    if (hoverRafRef.current) return;
    hoverRafRef.current = requestAnimationFrame(() => {
      hoverRafRef.current = 0;
      hoverRef.current();
    });
  };
  const clearHover = (): void => {
    hoverEvRef.current = null;
    if (hoverNodeRef.current || hoverEdgeRef.current) {
      hoverNodeRef.current = null;
      hoverEdgeRef.current = null;
      drawOverlayNow();
    }
    if (useStore.getState().hoverEdge) setHoverEdge(null);
    setHoverClass(false);
  };
  useEffect(() => () => cancelAnimationFrame(hoverRafRef.current), []);

  const onMouseDown = (e: ReactMouseEvent): void => {
    if (e.button !== 0) return;
    if (onBackground(e.target)) {
      const hit = lod === 'canvas' ? pick(e.clientX, e.clientY) : null;
      if (hit?.kind === 'node') {
        startNodeDrag(e, hit.node);
        return;
      }
      if (hit?.kind === 'frame') {
        startFrameDrag(e, hit.frame.memberKeys);
        return;
      }
    }
    beginPan(e);
  };

  const onClick = (e: ReactMouseEvent): void => {
    if (wasDrag()) return;
    const hit = onBackground(e.target) ? pick(e.clientX, e.clientY) : null;
    if (hit?.kind === 'node') {
      selectNode(hit.node);
    } else if (hit?.kind === 'frame') {
      // a team at overview zoom: zoom onto it
      const f = hit.frame;
      fitBounds({ x0: f.x, y0: f.y, x1: f.x + f.w, y1: f.y + f.h });
    } else if (hit?.kind === 'edge') {
      select({ kind: 'edge', id: hit.key });
    } else {
      select(null);
      setFocus(null);
    }
  };

  const onDoubleClick = (e: ReactMouseEvent): void => {
    if (!onBackground(e.target) || lod !== 'canvas') return;
    const hit = pick(e.clientX, e.clientY);
    if (hit?.kind === 'node') openNode(hit.node);
    else if (hit?.kind === 'frame') toggleMerge(hit.frame.teamId);
  };

  // ---- mounted DOM layer ----
  // The card holding keyboard focus, so culling leaves it mounted.
  const [focusedCard, setFocusedCard] = useState<string | null>(null);
  const cardKeyOf = (t: EventTarget | null): string | null =>
    t instanceof Element ? (t.closest('[data-node-key]')?.getAttribute('data-node-key') ?? null) : null;
  const onWorldFocus = (e: ReactFocusEvent): void => {
    const key = cardKeyOf(e.target);
    setFocusedCard(key);
    // Focusing a card in the off-screen pad makes the browser scroll the
    // clipped canvas; undo that and pan the camera to the card instead.
    const el = canvasRef.current;
    if (el && (el.scrollLeft || el.scrollTop)) el.scrollLeft = el.scrollTop = 0;
    const n = key ? nodeById.get(key) : undefined;
    const p = key ? displayPos(key) : undefined;
    if (!n || !p) return;
    const box = { x0: p.x, y0: p.y, x1: p.x + widthOf(n), y1: p.y + heightOf(n) };
    const seen = visibleWorldRect(tfRef.current, viewport.w, viewport.h, -24);
    if (!containsRect(seen, box)) centerOn(box, selection ? { rightInset: DRAWER_W } : undefined);
  };
  const onWorldBlur = (e: ReactFocusEvent): void => {
    if (!worldRef.current?.contains(e.relatedTarget as Node | null)) setFocusedCard(null);
  };
  const rect = view?.rect ?? null;
  const showCards = lod === 'cards' && rect != null;
  const compact = view?.compact ?? false;

  // The selected, keyboard-focused and dragged cards stay mounted when they
  // leave the window: unmounting would drop focus or lose the card mid-drag.
  // A team dragged by its bar keeps the bar too (keyed by its first member).
  const dragged = draggedKeys();
  const keepMounted = new Set<string>(dragged ?? []);
  if (selNodeKey) keepMounted.add(selNodeKey);
  if (focusedCard) keepMounted.add(focusedCard);
  const draggedFrame = dragged?.[0] ?? null;
  const visibleFrames = useMemo(
    () =>
      showCards && rect
        ? frameViews.filter(
            (f) =>
              rectsOverlap(rect, { x0: f.x, y0: f.y, x1: f.x + f.w, y1: f.y + FRAME_TITLE_H }) ||
              f.memberKeys[0] === draggedFrame,
          )
        : [],
    [showCards, rect, frameViews, draggedFrame],
  );
  // Standing metric labels: unhealthy and selected edges in the window at card
  // zoom; only the selected one at overview zoom. The hovered edge's label is
  // HoverEdgeLabel.
  const labelEdges = useMemo(
    () =>
      edgeViews.filter((v) => {
        if (v.isSel) return true;
        if (!showCards || !rect || v.dim || v.e.status === 'ok') return false;
        return v.mid.x >= rect.x0 && v.mid.x <= rect.x1 && v.mid.y >= rect.y0 && v.mid.y <= rect.y1;
      }),
    [edgeViews, showCards, rect],
  );
  // Rendered card sizes, measured after commit. A team card grows with its
  // member chips past the layout's GROUP_H, and labels must clear what is
  // drawn. Sizes are stable per card, so this re-renders only when new
  // cards mount with a size not seen before.
  const cardSizeRef = useRef(new Map<string, { w: number; h: number }>());
  const [cardSizeVersion, setCardSizeVersion] = useState(0);
  useLayoutEffect(() => {
    const world = worldRef.current;
    if (!world || lod !== 'cards') return;
    let changed = false;
    for (const el of world.querySelectorAll<HTMLElement>('[data-node-key]')) {
      const key = el.dataset.nodeKey;
      if (!key) continue;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const prev = cardSizeRef.current.get(key);
      if (prev && prev.w === w && prev.h === h) continue;
      cardSizeRef.current.set(key, { w, h });
      changed = true;
    }
    if (changed) setCardSizeVersion((v) => v + 1);
  }, [view, lod, graph.nodes, selNodeKey, focusedCard]);

  // Labels sit on a free part of their edge, never over a card or a team
  // title bar; one with no free spot hides unless selected or hovered.
  const labelObstacles = (area: WorldRect): WorldRect[] => {
    const obstacles: WorldRect[] = [];
    for (const n of graph.nodes) {
      const p = displayPos(n.key);
      if (!p) continue;
      const sz = cardSizeRef.current.get(n.key);
      const box = { x0: p.x, y0: p.y, x1: p.x + (sz?.w ?? widthOf(n)), y1: p.y + (sz?.h ?? heightOf(n)) };
      if (rectsOverlap(area, box)) obstacles.push(box);
    }
    for (const f of frameViews) {
      const bar = { x0: f.x, y0: f.y, x1: f.x + f.w, y1: f.y + FRAME_TITLE_H };
      if (rectsOverlap(area, bar)) obstacles.push(bar);
    }
    return obstacles;
  };
  const labelSpots = useMemo(() => {
    const shown = labelEdges.filter(wantsLabel);
    if (!shown.length) return new Map<string, { x: number; y: number }>();
    const area = rect ?? visibleWorldRect(tfRef.current, viewport.w, viewport.h, CULL_PAD_PX);
    // critical edges claim free spots before degraded ones
    const rank = (v: EdgeView): number => (v.e.status === 'crit' ? 0 : 1);
    return placeEdgeLabels(
      [...shown].sort((x, y) => rank(x) - rank(y)).map((v) => ({
        key: v.e.key,
        curve: v.curve,
        w: labelBoxWidth(edgeLabelText(v)),
        h: LABEL_BOX_H,
        force: v.isSel,
      })),
      labelObstacles(area),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tfRef/viewport only matter when rect is unset
  }, [labelEdges, rect, graph.nodes, displayPos, frameViews, cardSizeVersion]);
  // The hovered edge's label, placed when the pointer reaches the edge.
  const hoverSpotRef = useRef<(v: EdgeView) => { x: number; y: number } | undefined>(() => undefined);
  hoverSpotRef.current = (v) => {
    // At overview zoom nodes are a few pixels each and there can be thousands
    // on screen: nothing there is worth routing a tooltip around.
    const area = visibleWorldRect(tfRef.current, viewport.w, viewport.h, 0);
    const obstacles = lod === 'cards' ? labelObstacles(area) : [];
    // the other edges' standing labels stay readable under a hover
    for (const o of labelEdges) {
      const p = o.e.key === v.e.key || !wantsLabel(o) ? undefined : labelSpots.get(o.e.key);
      if (!p) continue;
      const w = labelBoxWidth(edgeLabelText(o));
      obstacles.push({ x0: p.x - w / 2, y0: p.y - LABEL_BOX_H / 2, x1: p.x + w / 2, y1: p.y + LABEL_BOX_H / 2 });
    }
    return placeEdgeLabels(
      [{ key: v.e.key, curve: v.curve, w: labelBoxWidth(edgeLabelText(v, true)), h: LABEL_BOX_H, force: true }],
      obstacles,
    ).get(v.e.key);
  };
  const hoverSpot = useCallback((v: EdgeView) => hoverSpotRef.current(v), []);

  const cards: JSX.Element[] = [];
  if (showCards && rect) {
    for (const n of graph.nodes) {
      const p = displayPos(n.key);
      if (!p) continue;
      if (!shouldMount(rect, { x0: p.x, y0: p.y, x1: p.x + widthOf(n), y1: p.y + heightOf(n) }, n.key, keepMounted)) continue;
      cards.push(
        <NodeCard
          key={n.key}
          node={n}
          x={p.x}
          y={p.y}
          dim={dimmed(n.key)}
          selected={selNodeKey === n.key}
          teamLabel={teamGrouping ? null : n.teamName}
          compact={compact}
          fade={animating && animRef.current?.appear.has(n.key) ? eased : undefined}
          handlers={cardHandlers}
        />,
      );
    }
  }

  // The canvas overview draws services as pixels, so it carries a text
  // summary, and the map region takes keys to pan and zoom down to where
  // cards (which are focusable) mount. The Services table is the full list.
  const services = topology?.services;
  const summary = useMemo(() => mapSummary(services ?? [], lod === 'canvas'), [services, lod]);
  const onMapKey = (e: ReactKeyboardEvent): void => {
    if (e.target !== canvasRef.current && !worldRef.current?.contains(e.target as Node)) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const step = 80;
    const act: Record<string, () => void> = {
      ArrowLeft: () => panBy(step, 0),
      ArrowRight: () => panBy(-step, 0),
      ArrowUp: () => panBy(0, step),
      ArrowDown: () => panBy(0, -step),
      '+': () => zoomBy(1.3),
      '=': () => zoomBy(1.3),
      '-': () => zoomBy(1 / 1.3),
      _: () => zoomBy(1 / 1.3),
      '0': () => fitView(),
    };
    const fn = act[e.key];
    if (!fn) return;
    e.preventDefault();
    fn();
  };

  const hintShown =
    graph.nodes.length > 0 && (lod === 'canvas' ? !(view?.canvasLabels ?? false) : compact);

  return (
    <div className={styles.root}>
      <button type="button" className={styles.skipLink} onClick={() => navigate('services')}>
        Open the Services table (accessible list of every service)
      </button>
      <p id="map-keys-help" className={styles.srOnly}>
        Arrow keys pan, plus and minus zoom, 0 fits the whole map. Services become focusable once zoomed in; Enter
        selects one.
      </p>
      <div
        ref={canvasRef}
        role="region"
        aria-label="Service map"
        aria-describedby="map-keys-help"
        tabIndex={0}
        onKeyDown={onMapKey}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseLeave={clearHover}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        className={styles.canvas}
      >
        {/* packet glow sits below the map canvas, so edges and nodes draw over
            it and packets read as "absorbed" arriving at a service */}
        <PacketCanvas edges={edgeViews} tfRef={tfRef} />

        <canvas ref={surfaceRef} className={styles.surface} role="img" aria-label={summary} />
        {/* hover and selection highlights; hidden while it has nothing to show */}
        <canvas ref={overlayRef} className={styles.surface} style={{ display: 'none' }} aria-hidden />

        <div ref={worldRef} className={styles.world} onFocus={onWorldFocus} onBlur={onWorldBlur}>
          {/* frame title bars stay DOM at card zoom: they carry drag and merge */}
          {visibleFrames.map((f) => (
            <TeamFrameBar
              key={`bar:${f.teamId}`}
              teamId={f.teamId}
              name={f.name}
              memberCount={f.memberKeys.length}
              x={f.x}
              y={f.y}
              w={f.w}
              dim={f.dim}
              handlers={frameHandlers}
            />
          ))}

          {cards}

          {/* fading leftovers of removed nodes (e.g. members converging on a new group) */}
          {showCards &&
            animating &&
            animRef.current?.ghosts.map((g) => (
              <NodeCard
                key={`ghost:${g.node.key}`}
                node={g.node}
                x={g.from.x + (g.to.x - g.from.x) * eased}
                y={g.from.y + (g.to.y - g.from.y) * eased}
                dim={false}
                selected={false}
                ghost
                fade={1 - eased}
                handlers={NOOP_CARD_HANDLERS}
              />
            ))}

          <EdgeLabelLayer edges={labelEdges} spots={labelSpots} />
          <HoverEdgeLabel edges={edgeViews} spotFor={hoverSpot} />
        </div>

        <TeamChips
          teams={teams}
          teamFilter={teamFilter}
          allMerged={allMerged}
          showMerge={teamGrouping}
          onToggleMergeAll={() => {
            fitPendingRef.current = true;
            // The fit that follows picks the level of detail. Cards mounted for
            // the new graph at the old camera would be thrown away a frame later.
            mergeAllFromRef.current = { view: viewRef.current };
            setView((v) => (v && v.lod === 'cards' ? { ...v, lod: 'canvas' } : v));
            setMergedTeams(allMerged ? [] : teams.map((t) => t.id));
          }}
          onFilter={setTeamFilter}
        />

        {isolated && isolateLabel && (
          <IsolateBanner label={isolateLabel} onExit={() => setIsolate(null)} />
        )}

        {hintShown && <ZoomHint />}

        <Legend />

        <GraphModeToggle value={graphType} shifted={selection != null} onChange={setGraphType} />

        <ZoomControls
          shifted={selection != null}
          onZoomIn={() => zoomBy(1.3)}
          onZoomOut={() => zoomBy(1 / 1.3)}
          onFit={() => fitView()}
          onResetLayout={() => fitView(true)}
        />
      </div>

      <MapDrawer graph={graph} onToggleMerge={drawerToggleMerge} allowIsolate />
    </div>
  );
}
