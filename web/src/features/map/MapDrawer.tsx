import { useEffect, type ReactNode } from 'react';
import type { TopologyEdge, TopologyService } from '../../api/types';
import { HoverSync } from '../../components/hoverSync';
import { SloRing } from '../../components/SloRing';
import { TopErrors } from '../../components/TopErrors';
import { ARROW, DOT, fmtCount, fmtErr, fmtMs, fmtRps, jit } from '../../lib/format';
import { groupKey, type Graph, type GraphEdge } from '../../lib/grouping';
import { sloView, stColor } from '../../lib/status';
import { timeSince } from '../../lib/timeSince';
import { useStore } from '../../state/store';
import { Card } from './drawer/Card';
import { DepRow } from './drawer/DepRow';
import { DrawerHeader } from './drawer/DrawerHeader';
import { FooterButton } from './drawer/FooterButton';
import { GhostChip } from './drawer/GhostChip';
import { KpiGrid } from './drawer/KpiGrid';
import { SparkRow } from './drawer/SparkRow';
import { StatusPill } from './drawer/StatusPill';
import { useEdgeOps } from './drawer/useEdgeOps';
import { useSparklines } from './drawer/useSparklines';
import { useTopErrors } from './drawer/useTopErrors';
import styles from './MapDrawer.module.css';

export function MapDrawer({
  graph,
  onToggleMerge,
  allowIsolate = false,
}: {
  graph: Graph;
  /** Merge/unmerge a team in place (owned by the map so positions carry over). */
  onToggleMerge: (teamId: number) => void;
  /** Offer the "isolate tree" action. Layered map only -- the communities view
   *  cannot prune to a subtree, so it leaves this off. */
  allowIsolate?: boolean;
}) {
  const topology = useStore((s) => s.topology);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const focusId = useStore((s) => s.focusId);
  const setFocus = useStore((s) => s.setFocus);
  const isolateId = useStore((s) => s.isolateId);
  const setIsolate = useStore((s) => s.setIsolate);
  const navigate = useStore((s) => s.navigate);
  const tick = useStore((s) => s.tick);

  // Isolating supersedes focus dimming, so entering isolation clears any focus.
  const toggleIsolate = (key: string) => {
    if (isolateId === key) {
      setIsolate(null);
    } else {
      setIsolate(key);
      setFocus(null);
    }
  };
  const isolateButton = (key: string) =>
    allowIsolate ? (
      <FooterButton active={isolateId === key} onClick={() => toggleIsolate(key)}>
        {isolateId === key ? 'Exit isolated' : 'Isolate tree'}
      </FooterButton>
    ) : null;

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
  const nodeErrors = useTopErrors('service', nodeSvc?.id ?? null);
  const edgeErrors = useTopErrors('edge', single ? single.source : null, single?.target);

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
      <div className={styles.mode}>
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
        <div className={styles.body}>
          <Card variant="row">
            <SloRing target={s.sloTarget} attain={s.sloAttain} />
            <div className={styles.sloInfo}>
              <div className={styles.label}>{`SLO ${DOT} 30 DAYS`}</div>
              <div className={styles.sloTarget}>{slo.targetTxt} target</div>
              <div className={styles.sloTrack}>
                <div className={styles.sloFill} style={{ width: slo.budgetW, background: slo.color }} />
              </div>
              <div className={styles.sloBudget}>{slo.budgetTxt}</div>
            </div>
          </Card>

          <KpiGrid
            items={[
              { label: 'REQ/S', value: fmtRps(m.rps * jit(s.id, tick)) },
              { label: 'P95', value: fmtMs(m.p95 == null ? null : m.p95 * jit(s.id + 'l', tick, 0.06)) },
              { label: 'ERRORS', value: fmtErr(m.errPct), color: s.status === 'ok' ? 'var(--text)' : stColor(s.status) },
            ]}
          />

          <HoverSync>
            <Card variant="column">
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
          </HoverSync>

          <div>
            <div className={styles.sectionLabel}>{`CALLED BY ${DOT} ${callers.length}`}</div>
            <div className={styles.depList}>
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
            <div className={styles.sectionLabel}>{`DEPENDS ON ${DOT} ${depsOut.length}`}</div>
            <div className={styles.depList}>
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

          <TopErrors ops={nodeErrors} />

          <div className={styles.footnote}>
            {`topology learned from ~${fmtCount(m.rps * 86400)} spans/day ${DOT} updated continuously`}
          </div>
        </div>
        <div className={styles.footer}>
          <FooterButton primary onClick={() => navigate('service', s.id)}>
            View full service
          </FooterButton>
          <FooterButton active={focusActive} onClick={() => setFocus(focusActive ? null : s.id)}>
            {focusActive ? 'Unfocus' : 'Focus'}
          </FooterButton>
          {isolateButton(s.id)}
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
        <div className={styles.mode}>
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
          <div className={styles.body}>
            <KpiGrid
              items={[
                { label: 'REQ/S', value: fmtRps(gNode.rps * jit(gNode.key, tick)) },
                { label: 'WORST P95', value: fmtMs(gNode.p95) },
                { label: 'ERRORS', value: fmtErr(gNode.errPct), color: gNode.status === 'ok' ? 'var(--text)' : stColor(gNode.status) },
              ]}
            />
            <div>
              <div className={styles.sectionLabel}>{`MEMBERS ${DOT} ${members.length}`}</div>
              <div className={styles.depList}>
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
            <div className={styles.footnote}>
              unmerging separates this meganode back into its individual services
            </div>
          </div>
          <div className={styles.footer}>
            <FooterButton primary onClick={() => onToggleMerge(selection.teamId)}>
              Unmerge team
            </FooterButton>
            <FooterButton active={focusActive} onClick={() => setFocus(focusActive ? null : gNode.key)}>
              {focusActive ? 'Unfocus' : 'Focus'}
            </FooterButton>
            {isolateButton(gNode.key)}
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
        {srcNode?.label ?? graphEdge.sourceKey} <span className={styles.accent}>{ARROW}</span>{' '}
        {tgtNode?.label ?? graphEdge.targetKey}
      </>
    );
    const openSide = (key: string) => {
      const n = graph.nodes.find((x) => x.key === key);
      if (!n) return;
      if (n.kind === 'group') onToggleMerge(n.teamId as number);
      else navigate('service', n.key);
    };
    const focusActive = focusId === graphEdge.key;

    content = (
      <div className={styles.mode}>
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
        <div className={styles.body}>
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
              <HoverSync>
                <Card variant="column">
                  <SparkRow label="LATENCY 24H" data={edgeSparks?.p95} times={edgeSparks?.times} color="var(--accent)" fmt={fmtMs} />
                  <SparkRow label="CALL VOLUME" data={edgeSparks?.rps} times={edgeSparks?.times} color="var(--dim)" fmt={(v) => `${fmtRps(v)}/s`} />
                </Card>
              </HoverSync>

              <Card>
                <div className={styles.relLabel}>LEARNED RELATIONSHIP</div>
                {(
                  [
                    ['first observed', timeSince(single.firstSeen)],
                    ['supporting spans', fmtCount(single.samples)],
                    ['confidence', `${single.confidence.toFixed(1)}%`, 'var(--accent)'],
                    ['source', single.manual ? `manual ${DOT} user asserted` : `auto ${DOT} trace inference`],
                  ] as [string, string, string?][]
                ).map(([k, v, c]) => (
                  <div key={k} className={styles.kvRow}>
                    <span className={styles.kvKey}>{k}</span>
                    <span className={styles.kvVal} style={c ? { color: c } : undefined}>
                      {v}
                    </span>
                  </div>
                ))}
              </Card>

              {edgeOps.length > 0 && (
                <div>
                  <div className={styles.opsLabel}>OBSERVED OPERATIONS</div>
                  <div className={styles.opsList}>
                    {edgeOps.map((o) => (
                      <div key={o.name}>
                        <div className={styles.opHead}>
                          <span className={styles.opName}>{o.name}</span>
                          <span className={styles.opShare}>{Math.round(o.share * 100)}%</span>
                        </div>
                        <div className={styles.opTrack}>
                          <div className={styles.opFill} style={{ width: `${Math.round(o.share * 100)}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <TopErrors ops={edgeErrors} />
            </>
          ) : (
            <div>
              <div className={styles.sectionLabel}>UNDERLYING DEPENDENCIES</div>
              <div className={styles.depList}>
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
        <div className={styles.footer}>
          <FooterButton flex onClick={() => openSide(graphEdge.sourceKey)}>
            Open caller
          </FooterButton>
          <FooterButton primary onClick={() => openSide(graphEdge.targetKey)}>
            Open dependency
          </FooterButton>
          <FooterButton active={focusActive} onClick={() => setFocus(focusActive ? null : graphEdge.key)}>
            {focusActive ? 'Unfocus' : 'Focus'}
          </FooterButton>
          {isolateButton(graphEdge.key)}
        </div>
      </div>
    );
  }

  return <div className={`${styles.drawer} ${open ? styles.open : ''}`}>{content}</div>;
}
