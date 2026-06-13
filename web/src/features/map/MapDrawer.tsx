import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import type { TopologyEdge, TopologyService } from '../../api/types';
import { CloseIcon, ChevronIcon } from '../../components/Icon';
import { SloRing } from '../../components/SloRing';
import { Sparkline } from '../../components/Sparkline';
import { ARROW, DOT, fmtCount, fmtErr, fmtMs, fmtRps, jit } from '../../lib/format';
import { groupKey, type Graph, type GraphEdge } from '../../lib/grouping';
import { sloView, stBg, stColor, stLabel } from '../../lib/status';
import { useStore } from '../../state/store';

const mono = (px: number, weight = 500): string => `${weight} ${px}px 'JetBrains Mono', monospace`;
const LABEL: React.CSSProperties = { font: mono(9, 600), letterSpacing: '.16em', color: 'var(--faint)' };

interface SparkData {
  p95: number[];
  rps: number[];
  err: number[];
  times: Date[];
}

function useSparklines(kind: 'service' | 'edge', a: string | null, b?: string): SparkData | null {
  const [data, setData] = useState<SparkData | null>(null);
  useEffect(() => {
    setData(null);
    if (!a) return;
    let alive = true;
    const load = async () => {
      const res =
        kind === 'service' ? await api.serviceSparklines(a) : await api.edgeSeries(a, b as string);
      if (!alive) return;
      const pts = res.points;
      setData({
        p95: pts.map((p) => p.p95 ?? 0),
        rps: pts.map((p) => p.rps ?? 0),
        err: pts.map((p) => p.errPct ?? 0),
        times: pts.map((p) => new Date(p.t)),
      });
    };
    load().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [kind, a, b]);
  return data;
}

function useEdgeOps(source: string | null, target?: string) {
  const [ops, setOps] = useState<{ name: string; share: number }[]>([]);
  useEffect(() => {
    setOps([]);
    if (!source || !target) return;
    let alive = true;
    api
      .edgeSeries(source, target)
      .then((res) => alive && setOps(res.operations))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [source, target]);
  return ops;
}

function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 11,
        padding: '12px 13px',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function KpiGrid({ items }: { items: { label: string; value: string; color?: string }[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
      {items.map((k) => (
        <div
          key={k.label}
          style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 11px' }}
        >
          <div style={{ font: mono(8.5, 600), letterSpacing: '.1em', color: 'var(--faint)' }}>{k.label}</div>
          <div style={{ font: mono(15, 700), marginTop: 4, color: k.color ?? 'var(--text)' }}>{k.value}</div>
        </div>
      ))}
    </div>
  );
}

function SparkRow({
  label,
  data,
  times,
  color,
  fmt,
}: {
  label: string;
  data: number[] | undefined;
  times: Date[] | undefined;
  color: string;
  fmt: (v: number) => string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 86, flex: 'none', font: mono(8.5, 600), letterSpacing: '.1em', color: 'var(--faint)' }}>
        {label}
      </div>
      {data && data.length > 1 ? (
        <Sparkline data={data} times={times} color={color} fmt={fmt} dotColor={color} />
      ) : (
        <div style={{ flex: 1, height: 26, display: 'flex', alignItems: 'center', font: mono(9.5), color: 'var(--faint)' }}>
          collecting{'\u2026'}
        </div>
      )}
    </div>
  );
}

function DepRow({
  name,
  statusColor,
  right,
  onClick,
}: {
  name: string;
  statusColor: string;
  right: string;
  onClick: () => void;
}) {
  return (
    <div
      className="hov-row"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 8px', borderRadius: 8, cursor: 'pointer' }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, flex: 'none' }} />
      <span style={{ font: "600 12px 'Space Grotesk'", flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {name}
      </span>
      <span style={{ font: mono(10), color: 'var(--dim)' }}>{right}</span>
      <ChevronIcon />
    </div>
  );
}

function DrawerHeader({
  label,
  title,
  pills,
  meta,
  onClose,
}: {
  label: string;
  title: ReactNode;
  pills: ReactNode;
  meta?: string;
  onClose: () => void;
}) {
  return (
    <div style={{ padding: '16px 18px 13px', borderBottom: '1px solid var(--line)', flex: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div style={LABEL}>{label}</div>
        <div style={{ flex: 1 }} />
        <div
          className="hov-btn"
          onClick={onClose}
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: 'var(--faint)',
          }}
        >
          <CloseIcon />
        </div>
      </div>
      <div style={{ font: "700 18px 'Space Grotesk'", margin: '2px 0 9px', lineHeight: 1.4 }}>{title}</div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>{pills}</div>
      {meta && <div style={{ marginTop: 9, font: mono(10), color: 'var(--faint)' }}>{meta}</div>}
    </div>
  );
}

function StatusPill({ status }: { status: 'ok' | 'warn' | 'crit' }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        background: stBg(status),
        color: stColor(status),
        font: mono(10.5, 600),
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
      {stLabel(status)}
    </div>
  );
}

function GhostChip({ text }: { text: string }) {
  return (
    <div style={{ padding: '4px 10px', borderRadius: 999, border: '1px solid var(--line)', color: 'var(--dim)', font: mono(10.5, 600) }}>
      {text}
    </div>
  );
}

function FooterButton({
  primary,
  active,
  onClick,
  children,
  flex,
}: {
  primary?: boolean;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  flex?: boolean;
}) {
  return (
    <div
      className={primary ? 'hov-accent' : 'hov-btn'}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={
        primary
          ? {
              flex: 1,
              background: 'var(--accent)',
              color: 'var(--accent-ink)',
              borderRadius: 9,
              padding: 10,
              font: "600 12.5px 'Space Grotesk'",
              textAlign: 'center',
              cursor: 'pointer',
            }
          : {
              flex: flex ? 1 : undefined,
              border: `1px solid ${active ? 'var(--accent)' : 'var(--line2)'}`,
              color: active ? 'var(--accent)' : 'var(--dim)',
              borderRadius: 9,
              padding: '10px 14px',
              font: "600 12.5px 'Space Grotesk'",
              cursor: 'pointer',
              textAlign: 'center',
            }
      }
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function MapDrawer({
  graph,
  onToggleMerge,
}: {
  graph: Graph;
  /** Merge/unmerge a team in place (owned by the map so positions carry over). */
  onToggleMerge: (teamId: number) => void;
}) {
  const topology = useStore((s) => s.topology);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const focusId = useStore((s) => s.focusId);
  const setFocus = useStore((s) => s.setFocus);
  const navigate = useStore((s) => s.navigate);
  const tick = useStore((s) => s.tick);

  const open = selection != null;

  // Stale selection (e.g. graph regrouped): close gracefully.
  useEffect(() => {
    if (!selection || !topology) return;
    if (selection.kind === 'node' && !graph.nodes.some((n) => n.key === selection.id)) select(null);
    if (selection.kind === 'edge' && !graph.edges.some((e) => e.key === selection.id)) select(null);
    if (selection.kind === 'group' && !graph.nodes.some((n) => n.key === groupKey(selection.teamId))) select(null);
  }, [selection, graph, topology, select]);

  const svcById = new Map<string, TopologyService>((topology?.services ?? []).map((s) => [s.id, s]));
  const teamName = new Map<number, string>((topology?.teams ?? []).map((t) => [t.id, t.name]));

  const close = () => select(null);

  let content: ReactNode = null;

  // ============================ NODE MODE ============================
  const nodeSvc = selection?.kind === 'node' ? svcById.get(selection.id) : undefined;
  const nodeSparks = useSparklines('service', nodeSvc?.id ?? null);

  // ============================ EDGE MODE ============================
  const graphEdge: GraphEdge | undefined =
    selection?.kind === 'edge' ? graph.edges.find((e) => e.key === selection.id) : undefined;
  const single: TopologyEdge | null = graphEdge?.underlying.length === 1 ? graphEdge.underlying[0] : null;
  const edgeSparks = useSparklines('edge', single ? single.source : null, single?.target);
  const edgeOps = useEdgeOps(single ? single.source : null, single?.target);

  if (nodeSvc) {
    const s = nodeSvc;
    const m = s.metrics;
    const slo = sloView(s.sloTarget, s.sloAttain);
    const callers = (topology?.edges ?? []).filter((e) => e.target === s.id);
    const depsOut = (topology?.edges ?? []).filter((e) => e.source === s.id);
    const focusActive = focusId === s.id;
    const selectEdge = (e: TopologyEdge) => {
      const key = `${graph.nodeKeyOf(e.source)}=>${graph.nodeKeyOf(e.target)}`;
      select({ kind: 'edge', id: key });
    };
    const meta = [s.runtime, s.region, m.stale ? 'no recent traffic' : 'live'].filter(Boolean).join(` ${DOT} `);

    content = (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <DrawerHeader
          label={s.type.toUpperCase()}
          title={s.name}
          onClose={close}
          meta={meta}
          pills={
            <>
              <StatusPill status={s.status} />
              <GhostChip text={s.teamId != null ? (teamName.get(s.teamId) ?? 'unassigned') : 'unassigned'} />
            </>
          }
        />
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 13 }}>
          <Card style={{ padding: 13, display: 'flex', gap: 14, alignItems: 'center' }}>
            <SloRing target={s.sloTarget} attain={s.sloAttain} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={LABEL}>{`SLO ${DOT} 30 DAYS`}</div>
              <div style={{ font: "600 12.5px 'Space Grotesk'", marginTop: 3 }}>{slo.targetTxt} target</div>
              <div style={{ height: 5, background: 'var(--line)', borderRadius: 4, marginTop: 9, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: slo.budgetW, background: slo.color, borderRadius: 4 }} />
              </div>
              <div style={{ font: mono(9.5), color: 'var(--dim)', marginTop: 5 }}>{slo.budgetTxt}</div>
            </div>
          </Card>

          <KpiGrid
            items={[
              { label: 'REQ/S', value: fmtRps(m.rps * jit(s.id, tick)) },
              { label: 'P95', value: fmtMs(m.p95 == null ? null : m.p95 * jit(s.id + 'l', tick, 0.06)) },
              { label: 'ERRORS', value: fmtErr(m.errPct), color: s.status === 'ok' ? 'var(--text)' : stColor(s.status) },
            ]}
          />

          <Card style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <SparkRow label="LATENCY 24H" data={nodeSparks?.p95} times={nodeSparks?.times} color="var(--accent)" fmt={fmtMs} />
            <SparkRow label="THROUGHPUT" data={nodeSparks?.rps} times={nodeSparks?.times} color="var(--dim)" fmt={(v) => `${fmtRps(v)}/s`} />
            <SparkRow
              label="ERROR RATE"
              data={nodeSparks?.err}
              times={nodeSparks?.times}
              color={s.status === 'ok' ? 'var(--faint)' : stColor(s.status)}
              fmt={(v) => `${v.toFixed(2)}%`}
            />
          </Card>

          <div>
            <div style={{ ...LABEL, marginBottom: 6 }}>{`CALLED BY ${DOT} ${callers.length}`}</div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {callers.map((e) => (
                <DepRow
                  key={e.source}
                  name={svcById.get(e.source)?.name ?? e.source}
                  statusColor={stColor(svcById.get(e.source)?.status ?? 'ok')}
                  right={fmtMs(e.metrics.p95)}
                  onClick={() => selectEdge(e)}
                />
              ))}
            </div>
          </div>

          <div>
            <div style={{ ...LABEL, marginBottom: 6 }}>{`DEPENDS ON ${DOT} ${depsOut.length}`}</div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {depsOut.map((e) => (
                <DepRow
                  key={e.target}
                  name={svcById.get(e.target)?.name ?? e.target}
                  statusColor={stColor(svcById.get(e.target)?.status ?? 'ok')}
                  right={fmtMs(e.metrics.p95)}
                  onClick={() => selectEdge(e)}
                />
              ))}
            </div>
          </div>

          <div style={{ font: mono(9.5), color: 'var(--faint)' }}>
            {`topology learned from ~${fmtCount(m.rps * 86400)} spans/day ${DOT} updated continuously`}
          </div>
        </div>
        <div style={{ padding: '13px 18px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, flex: 'none' }}>
          <FooterButton primary onClick={() => navigate('service', s.id)}>
            View full service
          </FooterButton>
          <FooterButton active={focusActive} onClick={() => setFocus(focusActive ? null : s.id)}>
            {focusActive ? 'Unfocus' : 'Focus'}
          </FooterButton>
        </div>
      </div>
    );
  } else if (selection?.kind === 'group') {
    // ============================ GROUP MODE ============================
    const gNode = graph.nodes.find((n) => n.key === groupKey(selection.teamId));
    if (gNode) {
      const members = gNode.memberIds
        .map((id) => svcById.get(id))
        .filter((s): s is TopologyService => !!s)
        .sort((a, b) => b.metrics.rps - a.metrics.rps);
      const focusActive = focusId === gNode.key;
      content = (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          <DrawerHeader
            label="TEAM GROUP"
            title={gNode.label}
            onClose={close}
            meta={`meganode ${DOT} aggregates ${gNode.memberIds.length} services`}
            pills={
              <>
                <StatusPill status={gNode.status} />
                <GhostChip text={`${gNode.memberIds.length} services`} />
              </>
            }
          />
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 13 }}>
            <KpiGrid
              items={[
                { label: 'REQ/S', value: fmtRps(gNode.rps * jit(gNode.key, tick)) },
                { label: 'WORST P95', value: fmtMs(gNode.p95) },
                { label: 'ERRORS', value: fmtErr(gNode.errPct), color: gNode.status === 'ok' ? 'var(--text)' : stColor(gNode.status) },
              ]}
            />
            <div>
              <div style={{ ...LABEL, marginBottom: 6 }}>{`MEMBERS ${DOT} ${members.length}`}</div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {members.map((m) => (
                  <DepRow
                    key={m.id}
                    name={m.name}
                    statusColor={stColor(m.status)}
                    right={`${fmtRps(m.metrics.rps)}/s ${DOT} ${fmtMs(m.metrics.p95)}`}
                    onClick={() => {
                      onToggleMerge(selection.teamId);
                      select({ kind: 'node', id: m.id });
                    }}
                  />
                ))}
              </div>
            </div>
            <div style={{ font: mono(9.5), color: 'var(--faint)' }}>
              unmerging separates this meganode back into its individual services
            </div>
          </div>
          <div style={{ padding: '13px 18px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, flex: 'none' }}>
            <FooterButton primary onClick={() => onToggleMerge(selection.teamId)}>
              Unmerge team
            </FooterButton>
            <FooterButton active={focusActive} onClick={() => setFocus(focusActive ? null : gNode.key)}>
              {focusActive ? 'Unfocus' : 'Focus'}
            </FooterButton>
          </div>
        </div>
      );
    }
  } else if (graphEdge) {
    // ============================ EDGE MODE ============================
    const srcNode = graph.nodes.find((n) => n.key === graphEdge.sourceKey);
    const tgtNode = graph.nodes.find((n) => n.key === graphEdge.targetKey);
    const title = (
      <>
        {srcNode?.label ?? graphEdge.sourceKey} <span style={{ color: 'var(--accent)' }}>{ARROW}</span>{' '}
        {tgtNode?.label ?? graphEdge.targetKey}
      </>
    );
    const openSide = (key: string) => {
      const n = graph.nodes.find((x) => x.key === key);
      if (!n) return;
      if (n.kind === 'group') onToggleMerge(n.teamId as number);
      else navigate('service', n.key);
    };

    content = (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <DrawerHeader
          label={single ? 'DEPENDENCY EDGE' : 'GROUP EDGE'}
          title={title}
          onClose={close}
          pills={
            <>
              <StatusPill status={graphEdge.status} />
              <GhostChip text={`${graphEdge.confidence.toFixed(1)}% confidence`} />
              {!single && <GhostChip text={`${graphEdge.underlying.length} dependencies`} />}
            </>
          }
        />
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 13 }}>
          <KpiGrid
            items={[
              { label: 'CALLS/S', value: fmtRps(graphEdge.rps * jit(graphEdge.key, tick)) },
              { label: 'P95', value: fmtMs(graphEdge.p95 == null ? null : graphEdge.p95 * jit(graphEdge.key + 'l', tick, 0.06)) },
              {
                label: 'ERRORS',
                value: fmtErr(graphEdge.errPct),
                color: graphEdge.status === 'ok' ? 'var(--text)' : stColor(graphEdge.status),
              },
            ]}
          />

          {single ? (
            <>
              <Card style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <SparkRow label="LATENCY 24H" data={edgeSparks?.p95} times={edgeSparks?.times} color="var(--accent)" fmt={fmtMs} />
                <SparkRow label="CALL VOLUME" data={edgeSparks?.rps} times={edgeSparks?.times} color="var(--dim)" fmt={(v) => `${fmtRps(v)}/s`} />
              </Card>

              <Card>
                <div style={{ ...LABEL, marginBottom: 9 }}>LEARNED RELATIONSHIP</div>
                {(
                  [
                    ['first observed', timeSince(single.firstSeen)],
                    ['supporting spans', fmtCount(single.samples)],
                    ['confidence', `${single.confidence.toFixed(1)}%`, 'var(--accent)'],
                    ['source', single.manual ? `manual ${DOT} user asserted` : `auto ${DOT} trace inference`],
                  ] as [string, string, string?][]
                ).map(([k, v, c]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', font: mono(10.5), padding: '3px 0' }}>
                    <span style={{ color: 'var(--dim)' }}>{k}</span>
                    <span style={{ color: c ?? 'var(--text)' }}>{v}</span>
                  </div>
                ))}
              </Card>

              {edgeOps.length > 0 && (
                <div>
                  <div style={{ ...LABEL, marginBottom: 7 }}>OBSERVED OPERATIONS</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {edgeOps.map((o) => (
                      <div key={o.name}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', font: mono(10.5), marginBottom: 4 }}>
                          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.name}</span>
                          <span style={{ color: 'var(--dim)' }}>{Math.round(o.share * 100)}%</span>
                        </div>
                        <div style={{ height: 4, background: 'var(--line)', borderRadius: 3, overflow: 'hidden' }}>
                          <div
                            style={{
                              height: '100%',
                              width: `${Math.round(o.share * 100)}%`,
                              background: 'var(--accent)',
                              opacity: 0.65,
                              borderRadius: 3,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div>
              <div style={{ ...LABEL, marginBottom: 6 }}>UNDERLYING DEPENDENCIES</div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {graphEdge.underlying.map((e) => (
                  <DepRow
                    key={`${e.source}->${e.target}`}
                    name={`${svcById.get(e.source)?.name ?? e.source} ${ARROW} ${svcById.get(e.target)?.name ?? e.target}`}
                    statusColor={stColor(e.status)}
                    right={`${fmtMs(e.metrics.p95)} ${DOT} ${fmtErr(e.metrics.errPct)}`}
                    onClick={() => navigate('service', e.source)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
        <div style={{ padding: '13px 18px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, flex: 'none' }}>
          <FooterButton flex onClick={() => openSide(graphEdge.sourceKey)}>
            Open caller
          </FooterButton>
          <FooterButton primary onClick={() => openSide(graphEdge.targetKey)}>
            Open dependency
          </FooterButton>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 352,
        background: 'var(--bg2)',
        borderLeft: '1px solid var(--line)',
        transform: open ? 'translateX(0)' : 'translateX(105%)',
        transition: 'transform .28s cubic-bezier(.2,.8,.2,1)',
        zIndex: 20,
        boxShadow: open ? '-24px 0 60px rgba(0,0,0,.3)' : 'none',
      }}
    >
      {content}
    </div>
  );
}

function timeSince(iso: string): string {
  const days = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000));
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'} ago`;
  const hours = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000));
  if (hours >= 1) return `${hours}h ago`;
  return 'today';
}
