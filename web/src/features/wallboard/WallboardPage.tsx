import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { ServiceList, ServiceListItem } from '../../api/types';
import { TYPE_LABELS } from '../../components/Icon';
import { TeamFilter } from '../../components/TeamFilter';
import { DOT, fmtErr, fmtMs, fmtRps, jit } from '../../lib/format';
import { filterRankServices } from '../../lib/serviceRank';
import { sparkPath } from '../../lib/spark';
import { stBg, stColor, stLabel } from '../../lib/status';
import { useStore } from '../../state/store';
import styles from './WallboardPage.module.css';

/**
 * Wallboard: one card per service, readable from across the room. Same data,
 * filters, and health-first ranking as the services list -- only the rendering
 * differs: a responsive card grid where warn/crit tint the whole card surface
 * instead of a table row dot.
 */
export function WallboardPage() {
  const navigate = useStore((s) => s.navigate);
  const search = useStore((s) => s.search);
  const topology = useStore((s) => s.topology);
  const teamFilter = useStore((s) => s.teamFilter);
  const setTeamFilter = useStore((s) => s.setTeamFilter);
  const tick = useStore((s) => s.tick);
  const [data, setData] = useState<ServiceList | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => api.services().then((d) => alive && setData(d)).catch(() => undefined);
    void poll();
    const i = setInterval(poll, 15_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, []);

  const teams = topology?.teams ?? [];
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const total = data?.services.length ?? 0;
  const cards = filterRankServices(data?.services ?? [], search, teamFilter);
  const countLabel = cards.length === total ? `${total} services` : `${cards.length} of ${total} services`;

  return (
    <div className={styles.page}>
      <div className={styles.content}>
        <div className={styles.heading}>
          <div className={styles.headingText}>
            <div className={styles.title}>Wallboard</div>
            <div className={styles.subtitle}>{`${countLabel} ${DOT} one card per service ${DOT} sorted by health`}</div>
          </div>
          <TeamFilter teams={teams} value={teamFilter} onChange={setTeamFilter} />
        </div>
        <div className={styles.grid}>
          {cards.map((s) => (
            <ServiceCard
              key={s.id}
              service={s}
              team={s.teamId != null ? (teamName.get(s.teamId) ?? '--') : '--'}
              tick={tick}
              onOpen={() => navigate('service', s.id)}
            />
          ))}
        </div>
        {!cards.length && (
          <div className={styles.empty}>{data ? 'no services match' : 'waiting for telemetry…'}</div>
        )}
      </div>
    </div>
  );
}

function ServiceCard({
  service: s,
  team,
  tick,
  onOpen,
}: {
  service: ServiceListItem;
  team: string;
  tick: number;
  onOpen: () => void;
}) {
  const c = stColor(s.status);
  const unhealthy = s.status !== 'ok';
  return (
    <div
      className={`${styles.card} hov-row`}
      // stColor/stBg resolve status -> theme vars, so the tint stays inline
      style={unhealthy ? { borderColor: c, background: stBg(s.status) } : undefined}
      onClick={onOpen}
    >
      <div className={styles.cardTop}>
        <span className={styles.name}>{s.name}</span>
        <span className={styles.pill} style={{ color: c, background: stBg(s.status) }}>
          {stLabel(s.status)}
        </span>
      </div>
      <div className={styles.meta}>{`${team} ${DOT} ${TYPE_LABELS[s.type] ?? s.type.toUpperCase()}`}</div>
      <div className={styles.metrics}>
        <div className={styles.metricCell}>
          <span className={styles.metricLabel}>ERR</span>
          <span className={styles.err} style={{ color: unhealthy ? c : 'var(--text)' }}>
            {fmtErr(s.errPct)}
          </span>
        </div>
        <div className={styles.metricCell}>
          <span className={styles.metricLabel}>P95</span>
          <span className={styles.metricValue}>{fmtMs(s.p95)}</span>
        </div>
        <div className={styles.metricCell}>
          <span className={styles.metricLabel}>REQ/S</span>
          <span className={styles.metricValue}>{fmtRps(s.rps * jit(s.id, tick))}</span>
        </div>
      </div>
      <svg viewBox="0 0 120 26" preserveAspectRatio="none" className={styles.spark}>
        <path
          d={sparkPath(s.spark.length > 1 ? s.spark : [0, 0])}
          fill="none"
          stroke={unhealthy ? c : 'var(--faint)'}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
