import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useStore } from '../../state/store';
import { ARROW } from '../../lib/format';
import { LABEL_ZOOM_FACTOR } from '../../lib/preferences';
import { buildGraph, groupKey, type GraphEdge, type GraphNode } from '../../lib/grouping';
import { GROUP_H, GROUP_W, NODE_H, NODE_W } from '../../lib/layout';
import { layoutClusteredGraph } from '../../lib/clusterLayout';
import { computeEdgeGeometries } from '../../lib/edgeGeometry';
import { NodeCard } from './NodeCard';
import { TeamFrameBar, TeamFrameBox } from './TeamFrame';
import { MapDrawer } from './MapDrawer';
import { EdgeLabelLayer } from './view/EdgeLabelLayer';
import { EdgeLayer } from './view/EdgeLayer';
import { GraphModeToggle } from './view/GraphModeToggle';
import { Legend } from './view/Legend';
import { PacketCanvas } from './view/PacketCanvas';
import { TeamChips } from './view/TeamChips';
import { ZoomControls } from './view/ZoomControls';
import { buildEdgeViews } from './view/edgeViews';
import { dotAlphaScale } from './view/dotGrid';
import { buildDimmer } from './view/dimming';
import { computeFocusSet } from './view/focusSet';
import { isolateGraph } from './view/isolateGraph';
import { IsolateBanner } from './view/IsolateBanner';
import { ZoomHint } from './view/ZoomHint';
import { LABEL_MIN_K, fitZoom } from './view/camera';
import { nodeCardBounds } from './view/nodeBounds';
import { buildFrameViews } from './view/frameViews';
import { clearPinnedPositions, loadPinnedPositions, type NodePositions } from './view/pinnedPositions';
import { useGraphTransition } from './view/useGraphTransition';
import { useMergeHandoff } from './view/useMergeHandoff';
import { useNodeDrag } from './view/useNodeDrag';
import { usePanZoom } from './view/usePanZoom';
import { rectsOverlap, visibleWorldRect } from './view/viewport';
import styles from './MapView.module.css';

// Screen-pixel buffer kept around the viewport when culling: just-offscreen
// nodes/edges stay mounted so a small pan doesn't pop them in and out.
const CULL_MARGIN = 320;

// Drawer width (keep in step with MapDrawer.module.css .drawer width). The
// selection auto-center reserves it so the chosen node lands clear of the drawer.
const DRAWER_W = 352;

/** Layered dependency-flow view of the service map (the default graph type). */
export function LayeredMap() {
  const topology = useStore((s) => s.topology);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const hoverEdge = useStore((s) => s.hoverEdge);
  const setHoverEdge = useStore((s) => s.setHoverEdge);
  const focusId = useStore((s) => s.focusId);
  const setFocus = useStore((s) => s.setFocus);
  const isolateId = useStore((s) => s.isolateId);
  const setIsolate = useStore((s) => s.setIsolate);
  const search = useStore((s) => s.search);
  const teamFilter = useStore((s) => s.teamFilter);
  const setTeamFilter = useStore((s) => s.setTeamFilter);
  const mergedTeams = useStore((s) => s.mergedTeams);
  const toggleTeamMerged = useStore((s) => s.toggleTeamMerged);
  const setMergedTeams = useStore((s) => s.setMergedTeams);
  const navigate = useStore((s) => s.navigate);
  const tick = useStore((s) => s.tick);
  const graphType = useStore((s) => s.graphType);
  const setGraphType = useStore((s) => s.setGraphType);
  const labelZoom = useStore((s) => s.labelZoom);
  const teamGrouping = useStore((s) => s.teamGrouping);

  // Effective label threshold: the tuned default scaled by the user preference
  // ('always' zeroes it out, so labels never hide).
  const labelMinK = LABEL_MIN_K * LABEL_ZOOM_FACTOR[labelZoom];

  const canvasRef = useRef<HTMLDivElement>(null);
  const { tf, tfRef, dragging, beginPan, wasPan, zoomBy, fitBounds, centerOn } = usePanZoom(canvasRef);

  // Canvas size in CSS px, used to cull the world to the visible viewport.
  // Defaults to the window so the first paint (before the observer fires)
  // errs toward rendering everything rather than culling too aggressively.
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
  const { beginDrag, wasNodeDrag } = useNodeDrag(tfRef, setPinned);

  const fullGraph = useMemo(
    () =>
      topology
        ? buildGraph(topology, { mergedTeams, teamGrouping })
        : { nodes: [] as GraphNode[], edges: [] as GraphEdge[], nodeKeyOf: (id: string) => id },
    [topology, mergedTeams, teamGrouping],
  );

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

  // The layout must only depend on the graph's STRUCTURE. Metrics refresh
  // every poll (and the edge rows arrive in arbitrary order), so keying the
  // memo on a sorted structural signature stops nodes drifting on their own.
  const layoutSig = useMemo(
    () =>
      (teamGrouping ? 'grouped#' : 'flat#') +
      [...graph.nodes.map((n) => n.key)].sort().join('|') +
      '#' +
      [...graph.edges.map((e) => e.key)].sort().join('|'),
    [graph, teamGrouping],
  );

  // The layout is a pure function of structure (layoutSig), but a plain useMemo
  // only retains the LAST signature -- so every isolate enter/exit recomputed the
  // full 118-node layout from scratch (layoutClusteredGraph runs the layered DAG
  // solver ~once per team), a ~350ms main-thread stall on exit. Cache results by
  // signature so returning to a structure already seen (the full graph, on exit)
  // is instant. Bounded so a long session of merges/isolations stays small.
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

  const toggleMerge = useMergeHandoff({
    graph,
    layout,
    pinned,
    mergedTeams,
    posOf,
    setPinned,
    toggleTeamMerged,
  });

  const { animRef, animating, eased, displayPos, finishAnim } = useGraphTransition(graph, layoutSig, posOf);

  // Fit on first data, and after the merge-all/unmerge-all shortcut (whose
  // graph change is too big to stay oriented without one). Individual team
  // toggles deliberately do NOT re-fit: they expand/collapse in place.
  const fittedRef = useRef(false);
  const fitPendingRef = useRef(false);
  useEffect(() => {
    if (!graph.nodes.length) return;
    if (!fittedRef.current || fitPendingRef.current) {
      fittedRef.current = true;
      fitPendingRef.current = false;
      fitView();
    }
  }, [graph, fitView]);

  // Entering or leaving isolation reframes the map onto the new (much smaller,
  // or restored full) layout. fitView's deps already include the recomputed
  // layout, so by the time this effect runs the bbox is the isolated one. Skips
  // the initial mount so a deep-linked isolated load uses the first-data fit.
  const prevIsolateRef = useRef(isolateId);
  useEffect(() => {
    if (prevIsolateRef.current === isolateId) return;
    prevIsolateRef.current = isolateId;
    fitView();
  }, [isolateId, fitView]);

  // Toggling team grouping swaps the layout algorithm (clustered frames <->
  // flat team-agnostic flow), a wholesale re-flow of the whole map. Reframe onto
  // the freshly computed layout so the new arrangement is visible immediately.
  // Skips the initial mount (first-data fit handles that).
  const prevGroupingRef = useRef(teamGrouping);
  useEffect(() => {
    if (prevGroupingRef.current === teamGrouping) return;
    prevGroupingRef.current = teamGrouping;
    fitView();
  }, [teamGrouping, fitView]);

  // Drop a stale isolate id (e.g. a deep link to a service that no longer
  // exists, or one swallowed by a merged team) so the URL and map agree. Guard
  // on a loaded graph: before data arrives isolateGraph also returns the full
  // (empty) graph, and clearing then would wipe a valid deep link.
  useEffect(() => {
    if (isolateId && fullGraph.nodes.length && graph === fullGraph) setIsolate(null);
  }, [isolateId, fullGraph, graph, setIsolate]);

  const wasDrag = () => wasPan() || wasNodeDrag();

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

  const widthOf = (n: GraphNode) => (n.kind === 'group' ? GROUP_W : NODE_W);
  const heightOf = (n: GraphNode) => (n.kind === 'group' ? GROUP_H : NODE_H);

  // Zoom the camera onto the focus cone when Focus is switched on, and back to
  // the full layout when it's cleared. First-load and isolate fits are handled
  // by the effects above; this gives focus mode (which dims rather than prunes)
  // the same legible reframing isolation already gets. Guarded on focusId so a
  // metrics poll (which changes posOf/focus) never re-runs the fit.
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
    // If the whole cone fits at a readable zoom, frame it. In a layered DAG the
    // cone usually spans the gateway layer down to datastores, so fitting it
    // would shrink to specks -- in that case keep the focused node centered and
    // legible (its cone stays highlighted and pannable) instead.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reframe once per focus change; posOf/nodeById churn each poll
  }, [focusId, fitView, fitBounds, centerOn, viewport]);

  // Bring a freshly selected node/group to the centre of the visible map (clear
  // of the drawer) at a legible zoom -- so clicking, searching to, or deep
  // linking a service actually shows it instead of leaving it a speck. Keyed on
  // the selected key so it fires once per selection, not on every poll. Edge
  // selections are left alone; their focus/isolate actions reframe instead.
  const prevSelRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selNodeKey) {
      prevSelRef.current = null;
      return;
    }
    if (prevSelRef.current === selNodeKey) return;
    prevSelRef.current = selNodeKey;
    const n = nodeById.get(selNodeKey);
    const p = posOf(selNodeKey);
    if (!n || !p) return;
    centerOn({ x0: p.x, y0: p.y, x1: p.x + widthOf(n), y1: p.y + heightOf(n) }, { rightInset: DRAWER_W });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- center once per selection; posOf/nodeById churn each poll
  }, [selNodeKey, centerOn]);

  // ---- edge geometry + labels ----
  // Anchor sides come from the nodes' actual relative positions (the grouped
  // graph is cyclic and users can drag nodes anywhere, so fixed bottom->top
  // anchoring would lie about direction). The path runs dependency ->
  // dependent so the dash/packet animations show data flowing INTO the
  // dependent, where the arrowhead sits.
  const geoms = computeEdgeGeometries(
    graph.edges.map((e) => ({ key: e.key, fromKey: e.targetKey, toKey: e.sourceKey })),
    (key) => {
      const p = displayPos(key);
      const n = nodeById.get(key);
      return p && n ? { x: p.x, y: p.y, w: widthOf(n), h: heightOf(n) } : undefined;
    },
  );
  const edgeViews = buildEdgeViews(graph.edges, geoms, {
    dimmed,
    focusEdges: focus?.edges ?? null,
    selEdgeKey,
    hoverEdge,
    fadeInOf: (key) => (animating && animRef.current?.newEdges.has(key) ? eased : 1),
  });

  const teams = topology?.teams ?? [];
  const allMerged = teams.length > 0 && teams.every((t) => mergedTeams.includes(t.id));

  // Ownership frames are the visual half of team grouping; with grouping off
  // the map draws bare service cards (each labelled with its team) and no frames.
  const frameViews = teamGrouping ? buildFrameViews(teams, graph.nodes, displayPos, dimmed) : [];

  // ---- viewport culling ----
  // Edge geometry and anchor spreading stay computed over the FULL graph above
  // (so anchors don't shift as the visible set changes); only the DOM/SVG layers
  // below are trimmed to what's on screen. This is what makes zooming in cheap:
  // paint, hit-testing and the per-edge flow animation all scale with the number
  // of mounted elements, not the graph size.
  const visRect = useMemo(
    () => visibleWorldRect(tf, viewport.w, viewport.h, CULL_MARGIN),
    [tf, viewport],
  );
  const visibleEdgeViews = edgeViews.filter((v) => {
    const s = displayPos(v.e.sourceKey);
    const t = displayPos(v.e.targetKey);
    if (!s || !t) return false;
    return rectsOverlap(visRect, {
      x0: Math.min(s.x, t.x),
      y0: Math.min(s.y, t.y),
      x1: Math.max(s.x, t.x) + NODE_W,
      y1: Math.max(s.y, t.y) + NODE_H,
    });
  });
  const visibleFrames = frameViews.filter((f) =>
    rectsOverlap(visRect, { x0: f.x, y0: f.y, x1: f.x + f.w, y1: f.y + f.h }),
  );
  const nodeVisible = (key: string, w: number, h: number): boolean => {
    const p = displayPos(key);
    return p != null && rectsOverlap(visRect, { x0: p.x, y0: p.y, x1: p.x + w, y1: p.y + h });
  };

  // Too far out to read card text: render cards as clean status nodes and show
  // the "zoom in" hint, so the overview reads as intentional, not a broken blur.
  // Never applied while isolated: isolation is the deliberate "make this tree
  // legible" mode, so its labels stay on even when a deep tree fits below the
  // threshold (e.g. dynamo-bff fits ~0.44) -- hiding them there defeats the point.
  const labelsHidden = tf.k < labelMinK && !isolated;

  return (
    <div className={styles.root}>
      <div
        ref={canvasRef}
        onMouseDown={beginPan}
        onClick={() => {
          if (wasDrag()) return;
          select(null);
          setFocus(null);
        }}
        className={[
          styles.canvas,
          dragging ? styles.canvasDragging : '',
          animating && !dragging ? styles.canvasAnimating : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{
          backgroundSize: `${22 * tf.k}px ${22 * tf.k}px`,
          backgroundPosition: `${tf.tx}px ${tf.ty}px`,
          ['--dot-k' as string]: dotAlphaScale(tf.k),
        } as CSSProperties}
      >
        {/* packet glow sits below the world (edges + cards draw over it, so
            packets read as "absorbed" arriving at a service) */}
        <PacketCanvas edges={edgeViews} tfRef={tfRef} />

        <div
          className={`${styles.world} ${animating && !dragging ? styles.worldAnimating : ''}`}
          style={{ transform: `translate(${tf.tx}px, ${tf.ty}px) scale(${tf.k})` }}
        >
          {visibleFrames.map((f) => (
            <TeamFrameBox key={f.teamId} x={f.x} y={f.y} w={f.w} h={f.h} dim={f.dim} />
          ))}

          <EdgeLayer
            edges={visibleEdgeViews}
            wasDrag={wasDrag}
            onSelect={(key) => select({ kind: 'edge', id: key })}
            onHover={setHoverEdge}
          />

          {/* frame title bars render above the edges so their drag/merge
              interactions cannot be stolen by an edge's invisible hit path */}
          {visibleFrames.map((f) => (
            <TeamFrameBar
              key={`bar:${f.teamId}`}
              name={f.name}
              memberCount={f.memberKeys.length}
              x={f.x}
              y={f.y}
              w={f.w}
              dim={f.dim}
              onMerge={() => toggleMerge(f.teamId)}
              onDragStart={(ev) => {
                if (ev.button !== 0) return;
                ev.stopPropagation();
                finishAnim();
                beginDrag(
                  ev,
                  f.memberKeys.map((k) => {
                    const p = posOf(k) ?? { x: 0, y: 0 };
                    return { key: k, origX: p.x, origY: p.y };
                  }),
                );
              }}
            />
          ))}

          {graph.nodes.map((n) => {
            const p = displayPos(n.key);
            if (!p) return null;
            if (!nodeVisible(n.key, widthOf(n), heightOf(n))) return null;
            return (
              <NodeCard
                key={n.key}
                node={n}
                x={p.x}
                y={p.y}
                tick={tick}
                dim={dimmed(n.key)}
                selected={selNodeKey === n.key}
                teamLabel={teamGrouping ? null : n.teamName}
                compact={labelsHidden}
                fade={animating && animRef.current?.appear.has(n.key) ? eased : undefined}
                onDragStart={(ev) => {
                  if (ev.button !== 0) return;
                  ev.stopPropagation();
                  // Grabbing a mid-flight node settles the animation first so
                  // the pinned position is measured from the real target.
                  finishAnim();
                  const tp = posOf(n.key) ?? p;
                  beginDrag(ev, [{ key: n.key, origX: tp.x, origY: tp.y }]);
                }}
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (wasDrag()) return;
                  select(n.kind === 'group' ? { kind: 'group', teamId: n.teamId as number } : { kind: 'node', id: n.key });
                }}
                onOpen={() => {
                  if (n.kind === 'group') toggleMerge(n.teamId as number);
                  else navigate('service', n.key);
                }}
                onToggleGroup={n.kind === 'group' ? () => toggleMerge(n.teamId as number) : undefined}
              />
            );
          })}

          {/* fading leftovers of removed nodes (e.g. members converging on a new group) */}
          {animating &&
            animRef.current?.ghosts.map((g) => (
              <NodeCard
                key={`ghost:${g.node.key}`}
                node={g.node}
                x={g.from.x + (g.to.x - g.from.x) * eased}
                y={g.from.y + (g.to.y - g.from.y) * eased}
                tick={tick}
                dim={false}
                selected={false}
                ghost
                fade={1 - eased}
                onClick={() => {}}
                onOpen={() => {}}
              />
            ))}

          <EdgeLabelLayer edges={visibleEdgeViews} />
        </div>

        <TeamChips
          teams={teams}
          teamFilter={teamFilter}
          allMerged={allMerged}
          showMerge={teamGrouping}
          onToggleMergeAll={() => {
            fitPendingRef.current = true;
            setMergedTeams(allMerged ? [] : teams.map((t) => t.id));
          }}
          onFilter={setTeamFilter}
        />

        {isolated && isolateLabel && (
          <IsolateBanner label={isolateLabel} onExit={() => setIsolate(null)} />
        )}

        {labelsHidden && graph.nodes.length > 0 && <ZoomHint />}

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

      <MapDrawer graph={graph} onToggleMerge={toggleMerge} allowIsolate />
    </div>
  );
}
