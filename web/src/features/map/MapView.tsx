import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { buildGraph, groupKey, type GraphEdge, type GraphNode } from '../../lib/grouping';
import { GROUP_H, GROUP_W, NODE_H, NODE_W } from '../../lib/layout';
import { FRAME_PAD, FRAME_TITLE_H, layoutClusteredGraph } from '../../lib/clusterLayout';
import { computeGraphTransition, type GraphSnapshot, type GraphTransition, type Pos } from '../../lib/transition';
import { computeEdgeGeometries } from '../../lib/edgeGeometry';
import { flowDuration, packetCycle, packetDelays } from '../../lib/flow';
import { fmtMs, fmtRps, fmtErr, jit } from '../../lib/format';
import { stColor } from '../../lib/status';
import { NodeCard } from './NodeCard';
import { TeamFrameBar, TeamFrameBox } from './TeamFrame';
import { MapDrawer } from './MapDrawer';
import { FitIcon, ResetLayoutIcon } from '../../components/Icon';

const monoCss = (px: number, weight = 500): string => `${weight} ${px}px 'JetBrains Mono', monospace`;

interface Transform {
  tx: number;
  ty: number;
  k: number;
}

type NodePositions = Record<string, { x: number; y: number }>;

const POSITIONS_KEY = 'tracemap.nodePositions';

const ANIM_MS = 420;
// keep the CSS bezier (viewport) in step with this JS easing (nodes)
const ANIM_EASE_CSS = 'cubic-bezier(.33,1,.68,1)';
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

function loadPinnedPositions(): NodePositions {
  try {
    return JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? '{}') as NodePositions;
  } catch {
    return {};
  }
}

export function MapView() {
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

  const canvasRef = useRef<HTMLDivElement>(null);
  const [tf, setTf] = useState<Transform>({ tx: 60, ty: 40, k: 0.5 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);

  // User-pinned node positions (dragging a node overrides the auto-layout;
  // "fit" resets). Edges always follow the effective position. A drag moves
  // one node, or every member of a team when grabbed by its frame.
  const [pinned, setPinned] = useState<NodePositions>(loadPinnedPositions);
  const nodeDragRef = useRef<{
    items: { key: string; origX: number; origY: number }[];
    clientX: number;
    clientY: number;
    moved: boolean;
  } | null>(null);
  const tfRef = useRef(tf);
  tfRef.current = tf;

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
      const el = canvasRef.current;
      if (!el || !layout.pos.size) return;
      if (resetPinned) {
        setPinned({});
        localStorage.removeItem(POSITIONS_KEY);
      }
      const r = el.getBoundingClientRect();
      const bw = layout.bbox.x1 - layout.bbox.x0;
      const bh = layout.bbox.y1 - layout.bbox.y0;
      const k = Math.max(0.12, Math.min((r.width - 120) / bw, (r.height - 150) / bh, 1.1));
      setTf({
        tx: (r.width - bw * k) / 2 - layout.bbox.x0 * k,
        ty: (r.height - bh * k) / 2 - layout.bbox.y0 * k + 12,
        k,
      });
    },
    [layout],
  );

  /** Effective node position: user-pinned override wins over auto-layout. */
  const posOf = useCallback(
    (key: string): { x: number; y: number } | undefined => pinned[key] ?? layout.pos.get(key),
    [pinned, layout],
  );

  const persistPins = (next: NodePositions): NodePositions => {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(next));
    return next;
  };

  // ---- in-place merge/unmerge for dragged teams ----
  // The cluster layout already keeps an untouched team in the same slot when
  // it merges/unmerges. But once a team has been dragged (pinned), the layout
  // slot no longer matches where it sits, so hand the position across the
  // toggle: merging pins the meganode at the frame's center (consuming the
  // member pins), and unmerging re-pins the members around the meganode.
  const pendingUnmergeRef = useRef<{ teamId: number; cx: number; cy: number } | null>(null);

  const toggleMerge = useCallback(
    (teamId: number) => {
      if (!mergedTeams.includes(teamId)) {
        const members = graph.nodes.filter((n) => n.kind === 'service' && n.teamId === teamId);
        if (members.some((m) => pinned[m.key])) {
          let x0 = Infinity;
          let y0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          for (const m of members) {
            const p = posOf(m.key);
            if (!p) continue;
            x0 = Math.min(x0, p.x);
            y0 = Math.min(y0, p.y);
            x1 = Math.max(x1, p.x + NODE_W);
            y1 = Math.max(y1, p.y + NODE_H);
          }
          if (x0 !== Infinity) {
            setPinned((prev) => {
              const next = { ...prev };
              for (const m of members) delete next[m.key];
              next[groupKey(teamId)] = { x: (x0 + x1) / 2 - GROUP_W / 2, y: (y0 + y1) / 2 - GROUP_H / 2 };
              return persistPins(next);
            });
          }
        }
      } else {
        const gk = groupKey(teamId);
        const gp = pinned[gk];
        if (gp) {
          pendingUnmergeRef.current = { teamId, cx: gp.x + GROUP_W / 2, cy: gp.y + GROUP_H / 2 };
          setPinned((prev) => {
            const next = { ...prev };
            delete next[gk];
            return persistPins(next);
          });
        }
      }
      toggleTeamMerged(teamId);
    },
    [mergedTeams, graph, pinned, posOf, toggleTeamMerged],
  );

  // After an unmerge of a dragged team, the new layout is known: shift the
  // members' layout positions so their frame is centered where the meganode
  // sat, and pin them there.
  useLayoutEffect(() => {
    const pend = pendingUnmergeRef.current;
    if (!pend) return;
    const members = graph.nodes.filter((n) => n.kind === 'service' && n.teamId === pend.teamId);
    const pts = members.map((m) => layout.pos.get(m.key));
    if (!members.length || pts.some((p) => !p)) return; // layout not updated yet
    pendingUnmergeRef.current = null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pts as { x: number; y: number }[]) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + NODE_W);
      y1 = Math.max(y1, p.y + NODE_H);
    }
    const dx = pend.cx - (x0 + x1) / 2;
    const dy = pend.cy - (y0 + y1) / 2;
    setPinned((prev) => {
      const next = { ...prev };
      members.forEach((m, i) => {
        const p = pts[i] as { x: number; y: number };
        next[m.key] = { x: p.x + dx, y: p.y + dy };
      });
      return persistPins(next);
    });
  }, [graph, layout]);

  // ---- structural transition animation ----
  // When grouping/ungrouping (or any structure change) swaps the node set,
  // animate instead of snapping: survivors glide, revealed members fly out of
  // their old group, and collapsed members converge on it as fading ghosts.
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

  // Wheel zoom (non-passive listener so preventDefault works).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setTf((s) => {
        const k2 = Math.max(0.12, Math.min(2.4, s.k * Math.exp(-e.deltaY * 0.0014)));
        return { k: k2, tx: mx - ((mx - s.tx) * k2) / s.k, ty: my - ((my - s.ty) * k2) / s.k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Drag to pan the canvas, or drag a node to reposition it.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const nd = nodeDragRef.current;
      if (nd) {
        const dx = (e.clientX - nd.clientX) / tfRef.current.k;
        const dy = (e.clientY - nd.clientY) / tfRef.current.k;
        if (Math.abs(e.clientX - nd.clientX) + Math.abs(e.clientY - nd.clientY) > 4) nd.moved = true;
        if (nd.moved) {
          setPinned((prev) => {
            const next = { ...prev };
            for (const it of nd.items) next[it.key] = { x: it.origX + dx, y: it.origY + dy };
            return next;
          });
        }
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (d.moved) setTf((s) => ({ ...s, tx: d.tx + dx, ty: d.ty + dy }));
    };
    const onUp = () => {
      if (nodeDragRef.current) {
        setPinned((prev) => {
          localStorage.setItem(POSITIONS_KEY, JSON.stringify(prev));
          return prev;
        });
        setTimeout(() => {
          nodeDragRef.current = null;
        }, 0);
        return;
      }
      if (!dragRef.current) return;
      setDragging(false);
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
  }, []);

  const wasDrag = () => (dragRef.current?.moved || nodeDragRef.current?.moved) ?? false;

  const zoomBy = (f: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mx = r.width / 2;
    const my = r.height / 2;
    setTf((s) => {
      const k2 = Math.max(0.12, Math.min(2.4, s.k * f));
      return { k: k2, tx: mx - ((mx - s.tx) * k2) / s.k, ty: my - ((my - s.ty) * k2) / s.k };
    });
  };

  // ---- dimming (focus, search, team filter) ----
  const focusSet = useMemo(() => {
    if (!focusId) return null;
    const set = new Set<string>([focusId]);
    for (const e of graph.edges) {
      if (e.sourceKey === focusId) set.add(e.targetKey);
      if (e.targetKey === focusId) set.add(e.sourceKey);
    }
    return set;
  }, [focusId, graph]);

  const q = search.trim().toLowerCase();
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.key, n])), [graph]);
  const dimmed = useCallback(
    (key: string): boolean => {
      const n = nodeById.get(key);
      if (!n) return true;
      if (focusSet && !focusSet.has(key)) return true;
      if (q) {
        const hay =
          n.kind === 'group'
            ? [n.label, ...n.memberIds].join(' ').toLowerCase()
            : `${n.key} ${n.label}`.toLowerCase();
        if (!hay.includes(q)) return true;
      }
      if (teamFilter !== 'all') {
        if (n.kind === 'group') return n.teamId !== teamFilter;
        if (n.teamId !== teamFilter) return true;
      }
      return false;
    },
    [nodeById, focusSet, q, teamFilter],
  );

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
  const edgeViews = graph.edges.flatMap((e) => {
    const g = geoms.get(e.key);
    if (!g) return [];
    const dim = dimmed(e.sourceKey) || dimmed(e.targetKey);
    const isSel = selEdgeKey === e.key;
    const isHov = hoverEdge === e.key;
    const fadeIn = animating && animRef.current?.newEdges.has(e.key) ? eased : 1;
    const stc = e.status === 'crit' ? 'var(--crit)' : e.status === 'warn' ? 'var(--warn)' : 'var(--edge)';
    const flowC = e.status === 'crit' ? 'var(--crit)' : e.status === 'warn' ? 'var(--warn)' : 'var(--accent)';
    // Flow dash + packets only animate while traces are actually arriving:
    // an idle or stale edge keeps its base path but goes quiet.
    const live = e.rps > 0 && !e.stale;
    return [
      {
        e,
        d: g.d,
        dim,
        isSel,
        isHov,
        arrow: g.arrow,
        arrowFill: isSel || isHov ? 'var(--accent)' : e.status !== 'ok' ? stc : 'var(--accent)',
        arrowOp: (dim ? 0.04 : isSel || isHov ? 0.95 : e.status !== 'ok' ? 0.9 : 0.55) * fadeIn,
        mid: g.mid,
        stroke: isSel || isHov ? 'var(--accent)' : stc,
        w: isSel ? 2 : isHov ? 1.8 : 1.1,
        op: (dim ? 0.04 : isSel ? 0.95 : isHov ? 0.85 : e.status !== 'ok' ? 0.75 : 0.4) * fadeIn,
        flowStroke: flowC,
        flowOp: (dim || !live ? 0 : e.status !== 'ok' ? 0.95 : 0.7) * fadeIn,
        dur: flowDuration(e.rps),
      },
    ];
  });

  const teams = topology?.teams ?? [];
  const allMerged = teams.length > 0 && teams.every((t) => mergedTeams.includes(t.id));

  // Ownership frames around each unmerged team's nodes. Bounds follow the
  // members' effective positions, so frames stretch during drags and glide
  // along with merge/unmerge animations.
  const frameViews = teams.flatMap((t) => {
    const members = graph.nodes.filter((n) => n.kind === 'service' && n.teamId === t.id);
    if (!members.length) return [];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const m of members) {
      const p = displayPos(m.key);
      if (!p) continue;
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + NODE_W);
      y1 = Math.max(y1, p.y + NODE_H);
    }
    if (x0 === Infinity) return [];
    return [
      {
        teamId: t.id,
        name: t.name,
        memberKeys: members.map((m) => m.key),
        x: x0 - FRAME_PAD,
        y: y0 - FRAME_TITLE_H,
        w: x1 - x0 + 2 * FRAME_PAD,
        h: y1 - y0 + FRAME_TITLE_H + FRAME_PAD,
        dim: members.every((m) => dimmed(m.key)),
      },
    ];
  });

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div
        ref={canvasRef}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          dragRef.current = { x: e.clientX, y: e.clientY, tx: tf.tx, ty: tf.ty, moved: false };
          setDragging(true);
        }}
        onClick={() => {
          if (wasDrag()) return;
          select(null);
          setFocus(null);
        }}
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          cursor: dragging ? 'grabbing' : 'grab',
          backgroundImage: 'radial-gradient(var(--dot) 1px, transparent 1.4px)',
          backgroundSize: `${22 * tf.k}px ${22 * tf.k}px`,
          backgroundPosition: `${tf.tx}px ${tf.ty}px`,
          transition:
            animating && !dragging
              ? `background-size ${ANIM_MS}ms ${ANIM_EASE_CSS}, background-position ${ANIM_MS}ms ${ANIM_EASE_CSS}`
              : 'none',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 0,
            height: 0,
            transform: `translate(${tf.tx}px, ${tf.ty}px) scale(${tf.k})`,
            transformOrigin: '0 0',
            transition: animating && !dragging ? `transform ${ANIM_MS}ms ${ANIM_EASE_CSS}` : 'none',
          }}
        >
          {frameViews.map((f) => (
            <TeamFrameBox key={f.teamId} x={f.x} y={f.y} w={f.w} h={f.h} dim={f.dim} />
          ))}

          <svg width="8000" height="3000" style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}>
            {edgeViews.map((v) => (
              <g key={v.e.key}>
                <path d={v.d} fill="none" stroke={v.stroke} strokeWidth={v.w} opacity={v.op} />
                <path
                  d={v.d}
                  fill="none"
                  stroke={v.flowStroke}
                  strokeWidth="1.7"
                  opacity={v.flowOp}
                  strokeDasharray="2.5 9.5"
                  strokeLinecap="round"
                  style={{ animation: `flow ${v.dur} linear infinite` }}
                />
                <polygon points={v.arrow} fill={v.arrowFill} opacity={v.arrowOp} />
                <path
                  d={v.d}
                  fill="none"
                  stroke="rgba(0,0,0,0)"
                  strokeWidth="16"
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (!wasDrag()) select({ kind: 'edge', id: v.e.key });
                  }}
                  onMouseEnter={() => setHoverEdge(v.e.key)}
                  onMouseLeave={() => setHoverEdge(null)}
                />
              </g>
            ))}
          </svg>

          {/* glowing packets traveling each live edge (pure CSS offset-path;
              the wrapper carries dim/fade so the keyframes own opacity).
              Packet count per cycle scales with the edge's measured call
              rate, so what you see tracks traces actually being received. */}
          {edgeViews
            .filter((v) => v.flowOp > 0)
            .map((v) => (
              <div
                key={`packet:${v.e.key}`}
                style={{ position: 'absolute', left: 0, top: 0, opacity: v.flowOp, pointerEvents: 'none' }}
              >
                {packetDelays(v.e.key, v.e.rps).map((delay, i) => (
                  <div
                    key={i}
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: v.flowStroke,
                      boxShadow: `0 0 7px 1px ${v.flowStroke}`,
                      offsetPath: `path("${v.d}")`,
                      animation: `packet ${packetCycle(v.e.rps)} linear infinite`,
                      animationDelay: delay,
                    }}
                  />
                ))}
              </div>
            ))}

          {/* frame title bars render above the edges so their drag/merge
              interactions cannot be stolen by an edge's invisible hit path */}
          {frameViews.map((f) => (
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
                nodeDragRef.current = {
                  items: f.memberKeys.map((k) => {
                    const p = posOf(k) ?? { x: 0, y: 0 };
                    return { key: k, origX: p.x, origY: p.y };
                  }),
                  clientX: ev.clientX,
                  clientY: ev.clientY,
                  moved: false,
                };
              }}
            />
          ))}

          {graph.nodes.map((n) => {
            const p = displayPos(n.key);
            if (!p) return null;
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
                  nodeDragRef.current = {
                    items: [{ key: n.key, origX: tp.x, origY: tp.y }],
                    clientX: ev.clientX,
                    clientY: ev.clientY,
                    moved: false,
                  };
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

          {edgeViews
            .filter((v) => !v.dim && (v.isSel || v.isHov || v.e.status !== 'ok'))
            .map((v) => {
              const full = v.isSel || v.isHov;
              return (
                <div
                  key={`label:${v.e.key}`}
                  style={{ position: 'absolute', left: 0, top: 0, transform: `translate(${v.mid.x}px, ${v.mid.y}px)`, pointerEvents: 'none' }}
                >
                  <div
                    style={{
                      transform: 'translate(-50%,-50%)',
                      background: 'var(--bg2)',
                      border: `1px solid ${v.isSel ? 'var(--accent)' : v.e.status === 'ok' ? 'var(--line2)' : stColor(v.e.status)}`,
                      color: v.e.status === 'ok' ? 'var(--dim)' : stColor(v.e.status),
                      borderRadius: 6,
                      padding: '2px 7px',
                      font: monoCss(9.5, 600),
                      whiteSpace: 'nowrap',
                      boxShadow: '0 2px 10px rgba(0,0,0,.25)',
                    }}
                  >
                    {full
                      ? `${fmtRps(v.e.rps)}/s \u00B7 ${fmtMs(v.e.p95)} \u00B7 ${fmtErr(v.e.errPct)}`
                      : fmtMs(v.e.p95)}
                  </div>
                </div>
              );
            })}
        </div>

        {/* team filter + grouping chips */}
        <div style={{ position: 'absolute', top: 14, left: 16, display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: '55%' }}>
          <div
            onClick={(e) => {
              e.stopPropagation();
              fitPendingRef.current = true;
              setMergedTeams(allMerged ? [] : teams.map((t) => t.id));
            }}
            style={{
              padding: '5px 11px',
              borderRadius: 999,
              border: `1px solid ${allMerged ? 'var(--accent)' : 'var(--line)'}`,
              background: allMerged ? 'var(--accent-dim)' : 'var(--bg2)',
              color: allMerged ? 'var(--accent)' : 'var(--dim)',
              font: monoCss(10.5, 600),
              letterSpacing: '.03em',
              cursor: 'pointer',
              backdropFilter: 'blur(6px)',
            }}
          >
            {allMerged ? 'Unmerge all teams' : 'Merge all teams'}
          </div>
          <div style={{ width: 1, height: 24, background: 'var(--line)', margin: '1px 2px' }} />
          {[{ id: 'all' as const, name: 'All teams' }, ...teams].map((t) => {
            const act = teamFilter === (t.id === 'all' ? 'all' : t.id);
            return (
              <div
                key={String(t.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  setTeamFilter(t.id === 'all' ? 'all' : (t.id as number));
                }}
                style={{
                  padding: '5px 11px',
                  borderRadius: 999,
                  border: `1px solid ${act ? 'var(--accent)' : 'var(--line)'}`,
                  background: act ? 'var(--accent-dim)' : 'var(--bg2)',
                  color: act ? 'var(--accent)' : 'var(--dim)',
                  font: monoCss(10.5, 600),
                  letterSpacing: '.03em',
                  cursor: 'pointer',
                  backdropFilter: 'blur(6px)',
                }}
              >
                {t.name}
              </div>
            );
          })}
        </div>

        {/* legend */}
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            left: 16,
            background: 'var(--bg2)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '10px 13px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            backdropFilter: 'blur(6px)',
          }}
        >
          {(
            [
              ['var(--ok)', 'healthy'],
              ['var(--warn)', 'degraded'],
              ['var(--crit)', 'critical'],
            ] as const
          ).map(([c, label]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, font: monoCss(10), color: 'var(--dim)' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: c }} />
              {label}
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, font: monoCss(10), color: 'var(--dim)' }}>
            <span style={{ width: 14, height: 0, borderTop: '1.4px dashed var(--line2)' }} />
            infra / external
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, font: monoCss(10), color: 'var(--dim)' }}>
            <svg width="14" height="10" viewBox="0 0 14 10" style={{ flex: 'none' }}>
              <line x1="0" y1="5" x2="9" y2="5" stroke="var(--accent)" strokeWidth="1.6" opacity="0.7" />
              <polygon points="14,5 8,1.8 8,8.2" fill="var(--accent)" opacity="0.85" />
            </svg>
            {'data flow \u2192 into dependent'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, font: monoCss(10), color: 'var(--dim)' }}>
            <span style={{ width: 14, height: 8, border: '1.4px solid var(--line2)', borderRadius: 3, boxSizing: 'border-box' }} />
            team frame
          </div>
        </div>

        {/* zoom stack */}
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            right: selection ? 368 : 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            transition: 'right .28s cubic-bezier(.2,.8,.2,1)',
          }}
        >
          {(
            [
              ['+', () => zoomBy(1.3)],
              ['\u2212', () => zoomBy(1 / 1.3)],
            ] as const
          ).map(([label, fn]) => (
            <div
              key={label}
              className="hov-btn"
              onClick={(e) => {
                e.stopPropagation();
                fn();
              }}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: 'var(--bg2)',
                border: '1px solid var(--line)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: 'var(--dim)',
                font: "600 16px 'Space Grotesk'",
              }}
            >
              {label}
            </div>
          ))}
          <div
            className="hov-btn"
            title="Fit to view"
            onClick={(e) => {
              e.stopPropagation();
              fitView();
            }}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: 'var(--bg2)',
              border: '1px solid var(--line)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--dim)',
            }}
          >
            <FitIcon />
          </div>
          <div
            className="hov-btn"
            title="Reset layout to default (clears dragged node positions)"
            onClick={(e) => {
              e.stopPropagation();
              fitView(true);
            }}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: 'var(--bg2)',
              border: '1px solid var(--line)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--dim)',
            }}
          >
            <ResetLayoutIcon />
          </div>
        </div>
      </div>

      <MapDrawer graph={graph} onToggleMerge={toggleMerge} />
    </div>
  );
}
