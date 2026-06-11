import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';

/** Lightweight hourly series for the inspector drawer sparklines. */
export async function seriesRoutes(app: FastifyInstance): Promise<void> {
  // 24 hourly points of a service's p95 / throughput / error rate.
  app.get('/services/:id/sparklines', async (req) => {
    const id = (req.params as { id: string }).id;
    const own = await query<{ t: Date; rps: string | null; err_pct: string | null; p95: string | null }>(
      `SELECT time_bucket_gapfill('1 hour', bucket, now() - INTERVAL '24 hours', now()) AS t,
              sum(span_count)::float8 / 3600 AS rps,
              sum(error_count)::float8 / NULLIF(sum(span_count), 0) * 100 AS err_pct,
              approx_percentile(0.95, rollup(lat_agg)) AS p95
       FROM service_op_metrics_1m
       WHERE service_id = $1 AND bucket >= now() - INTERVAL '24 hours' AND bucket < now()
       GROUP BY 1 ORDER BY 1`,
      [id],
    );
    let rows = own.rows;
    if (!rows.some((r) => r.rps != null)) {
      // External service: series from what callers observe.
      const ext = await query<typeof rows[number]>(
        `SELECT time_bucket_gapfill('1 hour', bucket, now() - INTERVAL '24 hours', now()) AS t,
                sum(call_count)::float8 / 3600 AS rps,
                sum(error_count)::float8 / NULLIF(sum(call_count), 0) * 100 AS err_pct,
                approx_percentile(0.95, rollup(lat_agg)) AS p95
         FROM edge_metrics_1m
         WHERE target_id = $1 AND bucket >= now() - INTERVAL '24 hours' AND bucket < now()
         GROUP BY 1 ORDER BY 1`,
        [id],
      );
      rows = ext.rows;
    }
    return {
      points: rows.map((r) => ({
        t: r.t,
        rps: r.rps == null ? null : Number(r.rps),
        errPct: r.err_pct == null ? null : Number(r.err_pct),
        p95: r.p95 == null ? null : Number(r.p95),
      })),
    };
  });

  // 24 hourly points of an edge's latency / call volume + operation mix.
  app.get('/edges/:source/:target/series', async (req) => {
    const { source, target } = req.params as { source: string; target: string };
    const [series, ops] = await Promise.all([
      query<{ t: Date; rps: string | null; err_pct: string | null; p95: string | null }>(
        `SELECT time_bucket_gapfill('1 hour', bucket, now() - INTERVAL '24 hours', now()) AS t,
                sum(call_count)::float8 / 3600 AS rps,
                sum(error_count)::float8 / NULLIF(sum(call_count), 0) * 100 AS err_pct,
                approx_percentile(0.95, rollup(lat_agg)) AS p95
         FROM edge_metrics_1m
         WHERE source_id = $1 AND target_id = $2
           AND bucket >= now() - INTERVAL '24 hours' AND bucket < now()
         GROUP BY 1 ORDER BY 1`,
        [source, target],
      ),
      query<{ operation: string; n: string }>(
        `SELECT operation, sum(call_count)::float8 AS n
         FROM edge_op_metrics_1m
         WHERE source_id = $1 AND target_id = $2 AND bucket >= now() - INTERVAL '24 hours'
         GROUP BY operation ORDER BY n DESC LIMIT 6`,
        [source, target],
      ),
    ]);
    const total = ops.rows.reduce((a, r) => a + Number(r.n), 0) || 1;
    return {
      points: series.rows.map((r) => ({
        t: r.t,
        rps: r.rps == null ? null : Number(r.rps),
        errPct: r.err_pct == null ? null : Number(r.err_pct),
        p95: r.p95 == null ? null : Number(r.p95),
      })),
      operations: ops.rows.map((r) => ({ name: r.operation, share: Number(r.n) / total })),
    };
  });
}
