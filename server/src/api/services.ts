import type { FastifyInstance } from 'fastify';
import { pool, query } from '../db/pool.js';
import { registry } from '../otlp/registry.js';
import {
  chartBucketSeconds,
  edgeConfidence,
  edgeLiveMetrics,
  serviceLiveMetrics,
  sloAttainment,
  statusOf,
} from './metrics.js';

function parseRange(q: Record<string, unknown>): { fromMs: number; toMs: number } {
  const toMs = q.to ? Date.parse(String(q.to)) : Date.now();
  const fromMs = q.from ? Date.parse(String(q.from)) : toMs - 24 * 3600 * 1000;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw Object.assign(new Error('invalid time range'), { statusCode: 400 });
  }
  return { fromMs, toMs };
}

export async function serviceRoutes(app: FastifyInstance): Promise<void> {
  // ---- list (services page) ----
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

  // ---- detail (service page; supports ?from=&to= ISO timestamps) ----
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

  // ---- edit name / description / team / type / slo ----
  app.patch('/services/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      displayName?: string | null;
      description?: string | null;
      teamId?: number | null;
      teamName?: string | null;
      type?: string;
      sloTarget?: number;
    };

    let teamId = body.teamId;
    if (body.teamName) {
      const t = await query<{ id: number }>(
        `INSERT INTO teams (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [body.teamName.trim()],
      );
      teamId = t.rows[0].id;
    }

    const sets: string[] = [];
    const vals: unknown[] = [id];
    const add = (sql: string, v: unknown) => {
      vals.push(v);
      sets.push(`${sql} = $${vals.length}`);
    };
    if ('displayName' in body) add('display_name', body.displayName || null);
    if ('description' in body) add('description', body.description || null);
    if (teamId !== undefined) add('team_id', teamId);
    if (body.type) add('type', body.type);
    if (body.sloTarget != null) add('slo_target', body.sloTarget);
    if (!sets.length) return reply.code(400).send({ error: 'nothing to update' });

    const res = await query(`UPDATE services SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, vals);
    if (!res.rowCount) return reply.code(404).send({ error: 'unknown service' });
    return { ok: true };
  });

  // ---- merge another discovered service into this one (manual association) ----
  app.post('/services/:id/merge', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { sourceId } = (req.body ?? {}) as { sourceId?: string };
    if (!sourceId || sourceId === id) return reply.code(400).send({ error: 'sourceId required' });

    const both = await query('SELECT id FROM services WHERE id = ANY($1)', [[id, sourceId]]);
    if (both.rowCount !== 2) return reply.code(404).send({ error: 'unknown service' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO service_aliases (alias, service_id) VALUES ($1, $2)
         ON CONFLICT (alias) DO UPDATE SET service_id = $2`,
        [sourceId, id],
      );
      // Re-point aliases that targeted the source.
      await client.query('UPDATE service_aliases SET service_id = $2 WHERE service_id = $1', [sourceId, id]);
      // Re-point historical telemetry.
      await client.query('UPDATE spans SET service_id = $2 WHERE service_id = $1', [sourceId, id]);
      await client.query('UPDATE spans SET peer_service_id = $2 WHERE peer_service_id = $1', [sourceId, id]);
      await client.query('UPDATE edge_events SET source_id = $2 WHERE source_id = $1', [sourceId, id]);
      await client.query('UPDATE edge_events SET target_id = $2 WHERE target_id = $1', [sourceId, id]);
      // Merge learned edges (drop any that became self-edges).
      await client.query(
        `INSERT INTO edges (source_id, target_id, first_seen, last_seen, sample_count, manual)
         SELECT $2, target_id, first_seen, last_seen, sample_count, manual FROM edges WHERE source_id = $1
         ON CONFLICT (source_id, target_id) DO UPDATE SET
           sample_count = edges.sample_count + EXCLUDED.sample_count,
           first_seen = LEAST(edges.first_seen, EXCLUDED.first_seen),
           last_seen = GREATEST(edges.last_seen, EXCLUDED.last_seen)`,
        [sourceId, id],
      );
      await client.query(
        `INSERT INTO edges (source_id, target_id, first_seen, last_seen, sample_count, manual)
         SELECT source_id, $2, first_seen, last_seen, sample_count, manual FROM edges WHERE target_id = $1
         ON CONFLICT (source_id, target_id) DO UPDATE SET
           sample_count = edges.sample_count + EXCLUDED.sample_count,
           first_seen = LEAST(edges.first_seen, EXCLUDED.first_seen),
           last_seen = GREATEST(edges.last_seen, EXCLUDED.last_seen)`,
        [sourceId, id],
      );
      await client.query('DELETE FROM edges WHERE source_id = $1 OR target_id = $1', [sourceId]);
      await client.query('DELETE FROM edges WHERE source_id = target_id');
      await client.query('DELETE FROM services WHERE id = $1', [sourceId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Rebuild the aggregates over the affected window so history follows the merge.
    for (const cagg of ['service_op_metrics_1m', 'edge_metrics_1m', 'edge_op_metrics_1m']) {
      await query(`CALL refresh_continuous_aggregate('${cagg}', now() - INTERVAL '30 days', now())`).catch(
        (err) => console.warn(`cagg refresh ${cagg} failed:`, err.message),
      );
    }
    await registry.load();
    return { ok: true, mergedInto: id, alias: sourceId };
  });

  // ---- manual dependency association ----
  app.post('/services/:id/dependencies', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { targetId } = (req.body ?? {}) as { targetId?: string };
    if (!targetId || targetId === id) return reply.code(400).send({ error: 'targetId required' });
    const both = await query('SELECT id FROM services WHERE id = ANY($1)', [[id, targetId]]);
    if (both.rowCount !== 2) return reply.code(404).send({ error: 'unknown service' });
    await query(
      `INSERT INTO edges (source_id, target_id, manual) VALUES ($1, $2, TRUE)
       ON CONFLICT (source_id, target_id) DO UPDATE SET manual = TRUE`,
      [id, targetId],
    );
    return { ok: true };
  });

  app.delete('/services/:id/dependencies/:targetId', async (req) => {
    const { id, targetId } = req.params as { id: string; targetId: string };
    await query('DELETE FROM edges WHERE source_id = $1 AND target_id = $2', [id, targetId]);
    return { ok: true };
  });
}
