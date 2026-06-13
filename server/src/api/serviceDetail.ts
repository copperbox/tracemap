import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import {
  chartBucketSeconds,
  edgeConfidence,
  edgeLiveMetrics,
  serviceLiveMetrics,
  sloAttainment,
  statusOf,
} from './metrics.js';
import { parseRange } from './range.js';

/** GET /services/:id: the service page detail (supports ?from=&to= ISO timestamps). */
export async function serviceDetailRoutes(app: FastifyInstance): Promise<void> {
  app.get('/services/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { fromMs, toMs } = parseRange(req.query as Record<string, unknown>);
    const bucketSec = chartBucketSeconds(fromMs, toMs);
    const from = new Date(fromMs);
    const to = new Date(toMs);

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
    }>('SELECT * FROM services WHERE id = $1', [id]);
    if (!svc.rowCount) return reply.code(404).send({ error: 'unknown service' });
    const s = svc.rows[0];

    const isExternal = s.is_external;
    const seriesSql = isExternal
      ? `SELECT time_bucket_gapfill(make_interval(secs => ${bucketSec}), bucket, $2::timestamptz, $3::timestamptz) AS t,
                sum(call_count)::float8 / ${bucketSec} AS rps,
                sum(error_count)::float8 / NULLIF(sum(call_count), 0) * 100 AS err_pct,
                approx_percentile(0.5,  rollup(lat_agg)) AS p50,
                approx_percentile(0.95, rollup(lat_agg)) AS p95,
                approx_percentile(0.99, rollup(lat_agg)) AS p99
         FROM edge_metrics_1m
         WHERE target_id = $1 AND bucket >= $2::timestamptz AND bucket < $3::timestamptz
         GROUP BY 1 ORDER BY 1`
      : `SELECT time_bucket_gapfill(make_interval(secs => ${bucketSec}), bucket, $2::timestamptz, $3::timestamptz) AS t,
                sum(span_count)::float8 / ${bucketSec} AS rps,
                sum(error_count)::float8 / NULLIF(sum(span_count), 0) * 100 AS err_pct,
                approx_percentile(0.5,  rollup(lat_agg)) AS p50,
                approx_percentile(0.95, rollup(lat_agg)) AS p95,
                approx_percentile(0.99, rollup(lat_agg)) AS p99
         FROM service_op_metrics_1m
         WHERE service_id = $1 AND bucket >= $2::timestamptz AND bucket < $3::timestamptz
         GROUP BY 1 ORDER BY 1`;

    const opsSql = `
      SELECT operation, sum(span_count)::float8 AS n,
             sum(error_count)::float8 / NULLIF(sum(span_count), 0) * 100 AS err_pct,
             approx_percentile(0.95, rollup(lat_agg)) AS p95,
             approx_percentile(0.99, rollup(lat_agg)) AS p99
      FROM service_op_metrics_1m
      WHERE service_id = $1 AND bucket >= $2::timestamptz AND bucket < $3::timestamptz
      GROUP BY operation ORDER BY n DESC LIMIT 8`;

    // For external services the per-operation stats come from edge_op_metrics
    // (call counts only - latency lives in edge_metrics).
    const extOpsSql = `
      SELECT operation, sum(call_count)::float8 AS n,
             NULL::float8 AS err_pct, NULL::float8 AS p95, NULL::float8 AS p99
      FROM edge_op_metrics_1m
      WHERE target_id = $1 AND bucket >= $2::timestamptz AND bucket < $3::timestamptz
      GROUP BY operation ORDER BY n DESC LIMIT 8`;

    const [series, ops, neighbors, svcMetrics, edgMetrics, slo, team] = await Promise.all([
      query<{
        t: Date;
        rps: string | null;
        err_pct: string | null;
        p50: string | null;
        p95: string | null;
        p99: string | null;
      }>(seriesSql, [id, from, to]),
      query<{ operation: string; n: string; err_pct: string | null; p95: string | null; p99: string | null }>(
        isExternal ? extOpsSql : opsSql,
        [id, from, to],
      ),
      query<{ source_id: string; target_id: string; sample_count: string; manual: boolean; first_seen: Date }>(
        'SELECT * FROM edges WHERE source_id = $1 OR target_id = $1',
        [id],
      ),
      serviceLiveMetrics(),
      edgeLiveMetrics(),
      sloAttainment(),
      s.team_id != null
        ? query<{ name: string }>('SELECT name FROM teams WHERE id = $1', [s.team_id])
        : Promise.resolve({ rows: [] as { name: string }[] }),
    ]);

    // KPIs over the selected range.
    const totals = series.rows.reduce(
      (acc, r) => {
        const rps = Number(r.rps ?? 0);
        acc.sumRps += rps;
        acc.points += 1;
        if (r.err_pct != null) acc.errAcc += Number(r.err_pct) * rps;
        acc.rpsAcc += rps;
        return acc;
      },
      { sumRps: 0, points: 0, errAcc: 0, rpsAcc: 0 },
    );
    let live = svcMetrics.get(id) ?? null;
    if (!live) {
      // External service: aggregate what callers observe.
      const incoming = [...edgMetrics.values()].filter((m) => m.target === id);
      if (incoming.length) {
        const rps = incoming.reduce((a, m) => a + m.rps, 0);
        const errW = incoming.reduce((a, m) => a + (m.errPct / 100) * m.rps, 0);
        const p95s = incoming.map((m) => m.p95).filter((v): v is number => v != null);
        live = {
          rps,
          p50: null,
          p95: p95s.length ? Math.max(...p95s) : null,
          p99: null,
          errPct: rps > 0 ? (errW / rps) * 100 : 0,
          stale: incoming.every((m) => m.stale),
        };
      }
    }

    const neighborOut = neighbors.rows.map((e) => {
      const m = edgMetrics.get(`${e.source_id}->${e.target_id}`);
      return {
        source: e.source_id,
        target: e.target_id,
        direction: e.source_id === id ? ('downstream' as const) : ('upstream' as const),
        otherId: e.source_id === id ? e.target_id : e.source_id,
        samples: Number(e.sample_count),
        manual: e.manual,
        firstSeen: e.first_seen,
        confidence: edgeConfidence(Number(e.sample_count), e.manual),
        rps: m?.rps ?? 0,
        p95: m?.p95 ?? null,
        errPct: m?.errPct ?? 0,
        status: statusOf(m?.errPct ?? 0),
      };
    });

    return {
      service: {
        id: s.id,
        name: s.display_name ?? s.id,
        description: s.description,
        type: s.type,
        teamId: s.team_id,
        teamName: team.rows[0]?.name ?? null,
        runtime: s.runtime,
        region: s.region,
        isExternal: s.is_external,
        sloTarget: s.slo_target,
        sloAttain: slo.get(id) ?? null,
        firstSeen: s.first_seen,
        lastSeen: s.last_seen,
        status: statusOf(live?.errPct ?? 0),
      },
      range: { from: from.toISOString(), to: to.toISOString(), bucketSeconds: bucketSec },
      kpis: {
        rps: live?.rps ?? (totals.points ? totals.sumRps / totals.points : 0),
        p50: live?.p50 ?? null,
        p95: live?.p95 ?? null,
        p99: live?.p99 ?? null,
        errPct: totals.rpsAcc > 0 ? totals.errAcc / totals.rpsAcc : (live?.errPct ?? 0),
        liveErrPct: live?.errPct ?? 0,
      },
      series: series.rows.map((r) => ({
        t: r.t,
        rps: r.rps == null ? null : Number(r.rps),
        errPct: r.err_pct == null ? null : Number(r.err_pct),
        p50: r.p50 == null ? null : Number(r.p50),
        p95: r.p95 == null ? null : Number(r.p95),
        p99: r.p99 == null ? null : Number(r.p99),
      })),
      operations: ops.rows.map((o) => ({
        name: o.operation,
        rps: Number(o.n) / ((toMs - fromMs) / 1000),
        errPct: o.err_pct == null ? null : Number(o.err_pct),
        p95: o.p95 == null ? null : Number(o.p95),
        p99: o.p99 == null ? null : Number(o.p99),
      })),
      neighbors: neighborOut,
    };
  });
}
