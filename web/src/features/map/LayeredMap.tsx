import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../state/store';
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
import { buildDimmer } from './view/dimming';
import { computeFocusSet } from './view/focusSet';
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

/** Layered dependency-flow view of the service map (the default graph type). */
export function LayeredMap() {
  const topology = useStore((s) => s.topology);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const hoverEdge = useStore((s) => s.hoverEdge);
  const setHoverEdge = useStore((s) => s.setHoverEdge);
  const focusId = useStore((s) => s.focusId);
  const setFocus = useStore((s) => s.setFocus);
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

  const canvasRef = useRef<HTMLDivElement>(null);
  const { tf, tfRef, dragging, beginPan, wasPan, zoomBy, fitBounds } = usePanZoom(canvasRef);

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

  const graph = useMemo(
    () =>
      topology
        ? buildGraph(topology, { mergedTeams })
        : { nodes: [] as GraphNode[], edges: [] as GraphEdge[], nodeKeyOf: (id: string) => id },
    [topology, mergedTeams],
  );

  // The layout must only depend on the graph's STRUCTURE. Metrics refresh
  // every poll (and the edge rows arrive in arbitrary order), so keying the
  // memo on a sorted structural signature stops nodes drifting on their own.
  const layoutSig = useMemo(
    () =>
      [...graph.nodes.map((n) => n.key)].sort().join('|') +
      '#' +
      [...graph.edges.map((e) => e.key)].sort().join('|'),
    [graph],
  );

  const layout = useMemo(() => {
    return layoutClusteredGraph(graph.nodes, graph.edges);
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

  const frameViews = buildFrameViews(teams, graph.nodes, displayPos, dimmed);

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
        }}
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
          onToggleMergeAll={() => {
            fitPendingRef.current = true;
            setMergedTeams(allMerged ? [] : teams.map((t) => t.id));
          }}
          onFilter={setTeamFilter}
        />

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

      <MapDrawer graph={graph} onToggleMerge={toggleMerge} />
    </div>
  );
}
