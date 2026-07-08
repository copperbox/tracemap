import type { ReactNode } from 'react';
import type { Topology, TopologyEdge, TopologyService } from '../../../api/types';
import { HoverSync } from '../../../components/hoverSync';
import { SloRing } from '../../../components/SloRing';
import { TopErrors } from '../../../components/TopErrors';
import { DOT, fmtCount, fmtErr, fmtMs, fmtRps, jit } from '../../../lib/format';
import { sloView, stColor } from '../../../lib/status';
import { useStore } from '../../../state/store';
import { Card } from './Card';
import { DepRow } from './DepRow';
import { DrawerHeader } from './DrawerHeader';
import { GhostChip } from './GhostChip';
import { KpiGrid } from './KpiGrid';
import { serviceMeta, serviceRelations } from './serviceRelations';
import { SparkRow } from './SparkRow';
import { StatusPill } from './StatusPill';
import { useSparklines } from './useSparklines';
import { useTopErrors } from './useTopErrors';
import styles from './ServiceDetails.module.css';

/**
 * Full service detail stack -- header, SLO ring, KPIs, 24h sparklines,
 * CALLED BY / DEPENDS ON lists and top erroring operations -- driven by the
 * raw topology, independent of any map view. The map drawer and the wallboard
 * drawer both render this, each supplying its own footer actions.
 */
export function ServiceDetails({
  service,
  topology,
  onClose,
  onSelectEdge,
  footer,
}: {
  service: TopologyService;
  topology: Topology;
  onClose: () => void;
  /** Clicking a CALLED BY / DEPENDS ON row. The map selects the corresponding
   *  map edge; other views can navigate instead, or omit to make rows inert. */
  onSelectEdge?: (edge: TopologyEdge) => void;
  /** Action buttons for the drawer footer (e.g. Focus / Isolate on the map). */
  footer?: ReactNode;
}) {
  const navigate = useStore((s) => s.navigate);
  const tick = useStore((s) => s.tick);

  const sparks = useSparklines('service', service.id);
  const errors = useTopErrors('service', service.id);

  const s = service;
  const m = s.metrics;
  const slo = sloView(s.sloTarget, s.sloAttain);
  const { callers, dependencies } = serviceRelations(topology, s.id);
  const svcById = new Map<string, TopologyService>(topology.services.map((x) => [x.id, x]));
  const teamName = new Map<number, string>(topology.teams.map((t) => [t.id, t.name]));

  const depRow = (e: TopologyEdge, otherId: string) => (
    <DepRow
      key={otherId}
      name={svcById.get(otherId)?.name ?? otherId}
      statusColor={stColor(svcById.get(otherId)?.status ?? 'ok')}
      right={fmtMs(e.metrics.p95)}
      onClick={onSelectEdge ? () => onSelectEdge(e) : undefined}
    />
  );

  return (
    <div className={styles.mode}>
      <DrawerHeader
        label={s.type.toUpperCase()}
        title={s.name}
        onClose={onClose}
        meta={serviceMeta(s)}
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
            <SparkRow label="LATENCY 24H" data={sparks?.p95} times={sparks?.times} color="var(--accent)" fmt={fmtMs} />
            <SparkRow label="THROUGHPUT" data={sparks?.rps} times={sparks?.times} color="var(--dim)" fmt={(v) => `${fmtRps(v)}/s`} />
            <SparkRow
              label="ERROR RATE"
              data={sparks?.err}
              times={sparks?.times}
              color={s.status === 'ok' ? 'var(--faint)' : stColor(s.status)}
              fmt={(v) => `${v.toFixed(2)}%`}
            />
          </Card>
        </HoverSync>

        <div>
          <div className={styles.sectionLabel}>{`CALLED BY ${DOT} ${callers.length}`}</div>
          <div className={styles.depList}>{callers.map((e) => depRow(e, e.source))}</div>
        </div>

        <div>
          <div className={styles.sectionLabel}>{`DEPENDS ON ${DOT} ${dependencies.length}`}</div>
          <div className={styles.depList}>{dependencies.map((e) => depRow(e, e.target))}</div>
        </div>

        <TopErrors
          ops={errors}
          onSelectOperation={(op) => navigate('service', s.id, op)}
        />

        <div className={styles.footnote}>
          {`topology learned from ~${fmtCount(m.rps * 86400)} spans/day ${DOT} updated continuously`}
        </div>
      </div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </div>
  );
}
