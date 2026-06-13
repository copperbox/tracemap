import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { serviceLiveMetrics, sloAttainment, statusOf } from './metrics.js';

/** GET /services: the services page listing with live metrics and sparklines. */
export async function serviceListRoutes(app: FastifyInstance): Promise<void> {
  app.get('/services', async () => {
    const [services, svcMetrics, slo, sparks, edgeCount] = await Promise.all([
      query<{
        id: string;
        display_name: string | null;
        type: string;
        team_id: number | null;
        runtime: string | null;
        is_external: boolean;
        slo_target: number;
        last_seen: Date;
      }>('SELECT id, display_name, type, team_id, runtime, is_external, slo_target, last_seen FROM services ORDER BY id'),
      serviceLiveMetrics(),
      sloAttainment(),
      query<{ service_id: string; t: Date; p95: string | null }>(
        `SELECT service_id, time_bucket('1 hour', bucket) AS t,
                approx_percentile(0.95, rollup(lat_agg)) AS p95
         FROM service_op_metrics_1m
         WHERE bucket > now() - INTERVAL '24 hours'
         GROUP BY service_id, 2
         ORDER BY service_id, 2`,
      ),
      query<{ n: string }>('SELECT count(*) AS n FROM edges'),
    ]);

    const sparkMap = new Map<string, number[]>();
    for (const row of sparks.rows) {
      const arr = sparkMap.get(row.service_id) ?? [];
      arr.push(row.p95 == null ? 0 : Number(row.p95));
      sparkMap.set(row.service_id, arr);
    }

    return {
      edgeCount: Number(edgeCount.rows[0]?.n ?? 0),
      services: services.rows.map((s) => {
        const m = svcMetrics.get(s.id) ?? { rps: 0, p95: null, errPct: 0, stale: true };
        return {
          id: s.id,
          name: s.display_name ?? s.id,
          type: s.type,
          teamId: s.team_id,
          runtime: s.runtime,
          isExternal: s.is_external,
          sloTarget: s.slo_target,
          sloAttain: slo.get(s.id) ?? null,
          lastSeen: s.last_seen,
          status: statusOf(m.errPct),
          rps: m.rps,
          p95: m.p95,
          errPct: m.errPct,
          spark: sparkMap.get(s.id) ?? [],
        };
      }),
    };
  });
}
