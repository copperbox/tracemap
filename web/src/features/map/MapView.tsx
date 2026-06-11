import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { buildGraph, groupKey, type GraphEdge, type GraphNode } from '../../lib/grouping';
import { layoutGraph, GROUP_H, GROUP_W, NODE_H, NODE_W } from '../../lib/layout';
import { flowDuration } from '../../lib/flow';
import { fmtMs, fmtRps, fmtErr, jit } from '../../lib/format';
import { stColor } from '../../lib/status';
import { NodeCard } from './NodeCard';
import { MapDrawer } from './MapDrawer';
import { FitIcon, ResetLayoutIcon } from '../../components/Icon';

const monoCss = (px: number, weight = 500): string => `${weight} ${px}px 'JetBrains Mono', monospace`;

interface Transform {
  tx: number;
  ty: number;
  k: number;
}

type NodePositions = Record<string, { x: number; y: number }>;

const POSITIONS_KEY = 'deptrace.nodePositions';

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
  const groupByTeam = useStore((s) => s.groupByTeam);
  const setGroupByTeam = useStore((s) => s.setGroupByTeam);
  const expandedTeams = useStore((s) => s.expandedTeams);
  const toggleTeamExpanded = useStore((s) => s.toggleTeamExpanded);
  const navigate = useStore((s) => s.navigate);
  const tick = useStore((s) => s.tick);

  const canvasRef = useRef<HTMLDivElement>(null);
  const [tf, setTf] = useState<Transform>({ tx: 60, ty: 40, k: 0.5 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);

  // User-pinned node positions (dragging a node overrides the auto-layout;
  // "fit" resets). Edges always follow the effective position.
  const [pinned, setPinned] = useState<NodePositions>(loadPinnedPositions);
  const nodeDragRef = useRef<{
    key: string;
    clientX: number;
    clientY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);
  const tfRef = useRef(tf);
  tfRef.current = tf;

  const graph = useMemo(
    () =>
      topology
        ? buildGraph(topology, { groupByTeam, expandedTeams })
        : { nodes: [] as GraphNode[], edges: [] as GraphEdge[], nodeKeyOf: (id: string) => id },
    [topology, groupByTeam, expandedTeams],
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
    const deps = new Map<string, string[]>();
    for (const e of [...graph.edges].sort((a, b) => a.key.localeCompare(b.key))) {
      const arr = deps.get(e.sourceKey) ?? [];
      arr.push(e.targetKey);
      deps.set(e.sourceKey, arr);
    }
    return layoutGraph({ keys: [...graph.nodes.map((n) => n.key)].sort(), deps });
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

  // Fit on first data + when grouping changes the graph shape.
  const fittedRef = useRef('');
  useEffect(() => {
    const sig = `${graph.nodes.length ? 1 : 0}:${groupByTeam}:${expandedTeams.join(',')}`;
    if (graph.nodes.length && fittedRef.current !== sig) {
      fittedRef.current = sig;
      fitView();
    }
  }, [graph, groupByTeam, expandedTeams, fitView]);

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
          setPinned((prev) => ({ ...prev, [nd.key]: { x: nd.origX + dx, y: nd.origY + dy } }));
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
  const edgeViews = graph.edges.flatMap((e) => {
    const a = posOf(e.sourceKey);
    const b = posOf(e.targetKey);
    const sn = nodeById.get(e.sourceKey);
    const tn = nodeById.get(e.targetKey);
    if (!a || !b || !sn || !tn) return [];
    // sx/sy: dependent's top edge (where data arrives); ex/ey: dependency's
    // bottom edge (where data originates). The path runs dependency -> dependent
    // so the dash animation shows data flowing DOWN into the dependent.
    const sx = a.x + widthOf(sn) / 2;
    const sy = a.y;
    const ex = b.x + widthOf(tn) / 2;
    const ey = b.y + heightOf(tn);
    const dy = Math.max(46, sy - ey);
    const d = `M ${ex} ${ey} C ${ex} ${ey + dy * 0.45}, ${sx} ${sy - dy * 0.45}, ${sx} ${sy}`;
    const dim = dimmed(e.sourceKey) || dimmed(e.targetKey);
    const isSel = selEdgeKey === e.key;
    const isHov = hoverEdge === e.key;
    const stc = e.status === 'crit' ? 'var(--crit)' : e.status === 'warn' ? 'var(--warn)' : 'var(--line2)';
    const flowC = e.status === 'crit' ? 'var(--crit)' : e.status === 'warn' ? 'var(--warn)' : 'var(--accent)';
    return [
      {
        e,
        d,
        dim,
        isSel,
        isHov,
        // Arrowhead at the dependent's top edge, pointing down into the node.
        arrow: `${sx},${sy} ${sx - 4.5},${sy - 8} ${sx + 4.5},${sy - 8}`,
        arrowFill: isSel || isHov ? 'var(--accent)' : e.status !== 'ok' ? stc : 'var(--accent)',
        arrowOp: dim ? 0.04 : isSel || isHov ? 0.95 : e.status !== 'ok' ? 0.9 : 0.55,
        mid: { x: (sx + ex) / 2, y: (sy + ey) / 2 },
        stroke: isSel || isHov ? 'var(--accent)' : stc,
        w: isSel ? 2 : isHov ? 1.8 : 1.1,
        op: dim ? 0.04 : isSel ? 0.95 : isHov ? 0.85 : e.status !== 'ok' ? 0.75 : 0.4,
        flowStroke: flowC,
        flowOp: dim ? 0 : e.status !== 'ok' ? 0.95 : 0.7,
        dur: flowDuration(e.rps),
      },
    ];
  });

  const teams = topology?.teams ?? [];

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
          }}
        >
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

          {graph.nodes.map((n) => {
            const p = posOf(n.key);
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
                onDragStart={(ev) => {
                  if (ev.button !== 0) return;
                  ev.stopPropagation();
                  nodeDragRef.current = {
                    key: n.key,
                    clientX: ev.clientX,
                    clientY: ev.clientY,
                    origX: p.x,
                    origY: p.y,
                    moved: false,
                  };
                }}
                expandedTeam={n.kind === 'group' ? false : groupByTeam && n.teamId != null && expandedTeams.includes(n.teamId)}
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (wasDrag()) return;
                  select(n.kind === 'group' ? { kind: 'group', teamId: n.teamId as number } : { kind: 'node', id: n.key });
                }}
                onOpen={() => {
                  if (n.kind === 'group') toggleTeamExpanded(n.teamId as number);
                  else navigate('service', n.key);
                }}
                onToggleGroup={
                  n.kind === 'group'
                    ? () => toggleTeamExpanded(n.teamId as number)
                    : groupByTeam && n.teamId != null
                      ? () => toggleTeamExpanded(n.teamId as number)
                      : undefined
                }
              />
            );
          })}

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
              setGroupByTeam(!groupByTeam);
            }}
            style={{
              padding: '5px 11px',
              borderRadius: 999,
              border: `1px solid ${groupByTeam ? 'var(--accent)' : 'var(--line)'}`,
              background: groupByTeam ? 'var(--accent-dim)' : 'var(--bg2)',
              color: groupByTeam ? 'var(--accent)' : 'var(--dim)',
              font: monoCss(10.5, 600),
              letterSpacing: '.03em',
              cursor: 'pointer',
              backdropFilter: 'blur(6px)',
            }}
          >
            {groupByTeam ? 'Grouped by team' : 'Group by team'}
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
            team group
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

      <MapDrawer graph={graph} />
    </div>
  );
}
