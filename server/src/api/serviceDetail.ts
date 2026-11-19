import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { getLive } from '../live/index.js';
import { edgeKey } from '../live/structure.js';
import { aliases } from './aliases.js';
import { readSeries } from './history.js';
import { chartBucketSeconds, edgeConfidence, errPct, q, sig4, sig4OrNull, statusOf } from './metrics.js';
import { parseRange } from './range.js';

/**
 * GET /services/:id: the service page detail (supports ?from=&to= ISO timestamps).
 * History comes from the rollup tiers for this service (and ids merged into
 * it) only; live numbers come from the shared snapshot.
 */
export async function serviceDetailRoutes(app: FastifyInstance): Promise<void> {
  app.get('/services/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { fromMs, toMs } = parseRange(req.query as Record<string, unknown>);
    const bucketSec = chartBucketSeconds(fromMs, toMs);
    const bucketMs = bucketSec * 1000;
    const from = new Date(fromMs);
    const to = new Date(toMs);
    const { reader, snapshot } = getLive();

    const svc = await query<{
      id: string;
      display_name: string | null;
      description: string | null;
      type: string;
      team_id: number | null;
      runtime: string | null;
      region: string | null;
      is_external: boolean;
      slo_target: number;
      first_seen: Date;
      last_seen: Date;
      team_name: string | null;
    }>('SELECT s.*, t.name AS team_name FROM services s LEFT JOIN teams t ON t.id = s.team_id WHERE s.id = $1', [id]);
    if (!svc.rowCount) return reply.code(404).send({ error: 'unknown service' });
    const s = svc.rows[0];
    const ids = aliases.expand(id);
    const canon = aliases.canonical;
    const isExternal = s.is_external;
    const range = { fromMs, toMs, bucketMs };

    const [series, ops, neighbors, snap] = await Promise.all([
      readSeries(
        reader,
        isExternal
          ? { ...range, kind: 'edge_rollup', filter: { target_id: ids } }
          : { ...range, kind: 'svc_rollup', filter: { service_id: ids } },
        canon,
      ),
      // External services: per-operation counts from what callers observe (no latency per operation).
      isExternal
        ? reader.totals({ ...range, kind: 'edge_op_rollup', filter: { target_id: ids }, groupBy: ['operation'] }, canon)
        : reader.totals({ ...range, kind: 'op_rollup', filter: { service_id: ids }, groupBy: ['operation'], hist: true }, canon),
      query<{ source_id: string; target_id: string; sample_count: string; manual: boolean; first_seen: Date }>(
        'SELECT source_id, target_id, sample_count, manual, first_seen FROM edges WHERE source_id = $1 OR target_id = $1',
        [id],
      ),
      snapshot.current(),
    ]);

    const live = snap.services.get(id) ?? null;
    const total = series.total;
    const rangeSec = Math.max(1, (Math.min(toMs, Date.now()) - Math.floor(fromMs / bucketMs) * bucketMs) / 1000);

    const neighborOut = neighbors.rows
      .filter((e) => e.source_id !== e.target_id)
      .map((e) => {
        const m = snap.edges.get(edgeKey(e.source_id, e.target_id));
        return {
          source: e.source_id,
          target: e.target_id,
          direction: e.source_id === id ? ('downstream' as const) : ('upstream' as const),
          otherId: e.source_id === id ? e.target_id : e.source_id,
          samples: Number(e.sample_count),
          manual: e.manual,
          firstSeen: e.first_seen,
          confidence: edgeConfidence(Number(e.sample_count), e.manual),
          rps: sig4(m?.rps ?? 0),
          p95: sig4OrNull(m?.p95 ?? null),
          errPct: sig4(m?.errPct ?? 0),
          // Status from the unrounded rate.
          status: statusOf(m?.errPct ?? 0),
          stale: m?.stale ?? true,
        };
      });

    ops.sort((a, b) => b.n - a.n);
    return {
      service: {
        id: s.id,
        name: s.display_name ?? s.id,
        description: s.description,
        type: s.type,
        teamId: s.team_id,
        teamName: s.team_name,
        runtime: s.runtime,
        region: s.region,
        isExternal: s.is_external,
        sloTarget: s.slo_target,
        sloAttain: sig4OrNull(snapshot.sloOf(id)),
        firstSeen: s.first_seen,
        lastSeen: s.last_seen,
        status: statusOf(live?.errPct ?? 0),
      },
      range: { from: from.toISOString(), to: to.toISOString(), bucketSeconds: bucketSec },
      kpis: {
        rps: sig4(live?.rps ?? (total ? total.n / rangeSec : 0)),
        p50: sig4OrNull(live?.p50 ?? null),
        p95: sig4OrNull(live?.p95 ?? null),
        p99: sig4OrNull(live?.p99 ?? null),
        errPct: sig4(errPct(total ?? undefined) ?? live?.errPct ?? 0),
        liveErrPct: sig4(live?.errPct ?? 0),
        stale: live?.stale ?? true,
      },
      series: series.points,
      operations: ops.slice(0, 8).map((o) => ({
        name: o.keys[0],
        rps: sig4(o.n / Math.max(1, (toMs - fromMs) / 1000)),
        errPct: sig4OrNull(errPct(o)),
        p95: sig4OrNull(q(o, 0.95)),
        p99: sig4OrNull(q(o, 0.99)),
      })),
      neighbors: neighborOut,
      aliases: aliases.aliasesOf(id),
    };
  });
}
