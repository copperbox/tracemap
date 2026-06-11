import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import {
  edgeConfidence,
  edgeLiveMetrics,
  serviceLiveMetrics,
  sloAttainment,
  statusOf,
  type LiveMetrics,
} from './metrics.js';

const EMPTY: LiveMetrics = { rps: 0, p50: null, p95: null, p99: null, errPct: 0, stale: true };

/**
 * GET /api/topology
 * The full live service map: every known service and learned edge with
 * current (or last-known) performance. No time range required.
 */
export async function topologyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/topology', async () => {
    const [services, edges, teams, svcMetrics, edgMetrics, slo] = await Promise.all([
      query<{
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
      }>('SELECT * FROM services ORDER BY id'),
      query<{
        source_id: string;
        target_id: string;
        first_seen: Date;
        last_seen: Date;
        sample_count: string;
        manual: boolean;
      }>('SELECT * FROM edges ORDER BY source_id, target_id'),
      query<{ id: number; name: string }>('SELECT id, name FROM teams ORDER BY name'),
      serviceLiveMetrics(),
      edgeLiveMetrics(),
      sloAttainment(),
    ]);

    // External services have no own telemetry: their node metrics are the
    // aggregate of what their callers observe.
    const incoming = new Map<string, { rps: number; errW: number; p95Max: number | null; stale: boolean }>();
    for (const m of edgMetrics.values()) {
      const agg = incoming.get(m.target) ?? { rps: 0, errW: 0, p95Max: null, stale: true };
      agg.rps += m.rps;
      agg.errW += (m.errPct / 100) * m.rps;
      if (m.p95 != null) agg.p95Max = Math.max(agg.p95Max ?? 0, m.p95);
      agg.stale = agg.stale && m.stale;
      incoming.set(m.target, agg);
    }

    const serviceOut = services.rows.map((s) => {
      let m = svcMetrics.get(s.id) ?? EMPTY;
      if (!svcMetrics.has(s.id)) {
        const inc = incoming.get(s.id);
        if (inc) {
          m = {
            rps: inc.rps,
            p50: null,
            p95: inc.p95Max,
            p99: null,
            errPct: inc.rps > 0 ? (inc.errW / inc.rps) * 100 : 0,
            stale: inc.stale,
          };
        }
      }
      return {
        id: s.id,
        name: s.display_name ?? s.id,
        description: s.description,
        type: s.type,
        teamId: s.team_id,
        runtime: s.runtime,
        region: s.region,
        isExternal: s.is_external,
        sloTarget: s.slo_target,
        sloAttain: slo.get(s.id) ?? null,
        firstSeen: s.first_seen,
        lastSeen: s.last_seen,
        status: statusOf(m.errPct),
        metrics: m,
      };
    });

    const known = new Set(services.rows.map((s) => s.id));
    const edgeOut = edges.rows
      .filter((e) => known.has(e.source_id) && known.has(e.target_id) && e.source_id !== e.target_id)
      .map((e) => {
        const m = edgMetrics.get(`${e.source_id}->${e.target_id}`) ?? EMPTY;
        return {
          source: e.source_id,
          target: e.target_id,
          firstSeen: e.first_seen,
          lastSeen: e.last_seen,
          samples: Number(e.sample_count),
          manual: e.manual,
          confidence: edgeConfidence(Number(e.sample_count), e.manual),
          status: statusOf(m.errPct),
          metrics: m,
        };
      });

    return {
      services: serviceOut,
      edges: edgeOut,
      teams: teams.rows,
      generatedAt: new Date().toISOString(),
    };
  });
}
