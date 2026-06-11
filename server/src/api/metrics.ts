import { query } from '../db/pool.js';
import { config } from '../config.js';

export type Status = 'ok' | 'warn' | 'crit';

export interface LiveMetrics {
  rps: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  errPct: number;
  /** True when values come from the last observed window rather than right now. */
  stale: boolean;
}

export function statusOf(errPct: number): Status {
  if (errPct > 2) return 'crit';
  if (errPct > 0.8) return 'warn';
  return 'ok';
}

/** Confidence in a learned edge, from its supporting span count. */
export function edgeConfidence(sampleCount: number, manual: boolean): number {
  if (manual) return 100;
  const c = 85 + 2.5 * Math.log10(sampleCount + 10);
  return Math.min(99.9, Math.max(50, Math.round(c * 10) / 10));
}

interface MetricRow {
  key: string;
  rps: string | number | null;
  err_pct: string | number | null;
  p50: string | number | null;
  p95: string | number | null;
  p99: string | number | null;
}

function toLive(row: MetricRow, stale: boolean): LiveMetrics {
  return {
    rps: Number(row.rps ?? 0),
    p50: row.p50 == null ? null : Number(row.p50),
    p95: row.p95 == null ? null : Number(row.p95),
    p99: row.p99 == null ? null : Number(row.p99),
    errPct: Number(row.err_pct ?? 0),
    stale,
  };
}

const SVC_AGG = `
  sum(span_count)::float8 / $WINDOW_SECONDS AS rps,
  sum(error_count)::float8 / NULLIF(sum(span_count), 0) * 100 AS err_pct,
  approx_percentile(0.5,  rollup(lat_agg)) AS p50,
  approx_percentile(0.95, rollup(lat_agg)) AS p95,
  approx_percentile(0.99, rollup(lat_agg)) AS p99`;

/**
 * Live per-service metrics over the last few minutes, with a fallback to the
 * most recently observed window for services with no current traffic (the map
 * always shows every service's last known state).
 */
export async function serviceLiveMetrics(): Promise<Map<string, LiveMetrics>> {
  const windowSec = config.liveWindowMinutes * 60;
  const out = new Map<string, LiveMetrics>();

  const live = await query<MetricRow>(
    `SELECT service_id AS key, ${SVC_AGG.replace('$WINDOW_SECONDS', String(windowSec))}
     FROM service_op_metrics_1m
     WHERE bucket > now() - make_interval(secs => ${windowSec})
     GROUP BY service_id`,
  );
  for (const row of live.rows) out.set(row.key, toLive(row, false));

  const fallback = await query<MetricRow>(
    `WITH latest AS (
       SELECT service_id, max(bucket) AS b
       FROM service_op_metrics_1m
       WHERE service_id <> ALL($1)
       GROUP BY service_id
     )
     SELECT m.service_id AS key, ${SVC_AGG.replace('$WINDOW_SECONDS', String(windowSec))}
     FROM service_op_metrics_1m m
     JOIN latest l ON l.service_id = m.service_id AND m.bucket > l.b - make_interval(secs => ${windowSec})
     GROUP BY m.service_id`,
    [[...out.keys()]],
  );
  for (const row of fallback.rows) out.set(row.key, toLive(row, true));

  return out;
}

export interface EdgeLiveMetrics extends LiveMetrics {
  source: string;
  target: string;
}

const EDGE_AGG = `
  sum(call_count)::float8 / $WINDOW_SECONDS AS rps,
  sum(error_count)::float8 / NULLIF(sum(call_count), 0) * 100 AS err_pct,
  approx_percentile(0.5,  rollup(lat_agg)) AS p50,
  approx_percentile(0.95, rollup(lat_agg)) AS p95,
  approx_percentile(0.99, rollup(lat_agg)) AS p99`;

export async function edgeLiveMetrics(): Promise<Map<string, EdgeLiveMetrics>> {
  const windowSec = config.liveWindowMinutes * 60;
  const out = new Map<string, EdgeLiveMetrics>();
  const keyOf = (s: string, t: string) => `${s}->${t}`;

  const live = await query<MetricRow & { source_id: string; target_id: string }>(
    `SELECT source_id, target_id, source_id || '->' || target_id AS key,
            ${EDGE_AGG.replace('$WINDOW_SECONDS', String(windowSec))}
     FROM edge_metrics_1m
     WHERE bucket > now() - make_interval(secs => ${windowSec})
     GROUP BY source_id, target_id`,
  );
  for (const row of live.rows) {
    out.set(keyOf(row.source_id, row.target_id), {
      ...toLive(row, false),
      source: row.source_id,
      target: row.target_id,
    });
  }

  const fallback = await query<MetricRow & { source_id: string; target_id: string }>(
    `WITH latest AS (
       SELECT source_id, target_id, max(bucket) AS b
       FROM edge_metrics_1m
       WHERE source_id || '->' || target_id <> ALL($1)
       GROUP BY source_id, target_id
     )
     SELECT m.source_id, m.target_id, m.source_id || '->' || m.target_id AS key,
            ${EDGE_AGG.replace('$WINDOW_SECONDS', String(windowSec))}
     FROM edge_metrics_1m m
     JOIN latest l ON l.source_id = m.source_id AND l.target_id = m.target_id
                  AND m.bucket > l.b - make_interval(secs => ${windowSec})
     GROUP BY m.source_id, m.target_id`,
    [[...out.keys()]],
  );
  for (const row of fallback.rows) {
    out.set(keyOf(row.source_id, row.target_id), {
      ...toLive(row, true),
      source: row.source_id,
      target: row.target_id,
    });
  }

  return out;
}

/**
 * 30-day SLO attainment (success-rate) per service. Heavier query, cached.
 */
let sloCache: { at: number; data: Map<string, number> } | null = null;

export async function sloAttainment(): Promise<Map<string, number>> {
  if (sloCache && Date.now() - sloCache.at < 60_000) return sloCache.data;
  const res = await query<{ service_id: string; attain: string }>(
    `SELECT service_id,
            100 - coalesce(sum(error_count)::float8 / NULLIF(sum(span_count), 0) * 100, 0) AS attain
     FROM service_op_metrics_1m
     WHERE bucket > now() - INTERVAL '30 days'
     GROUP BY service_id`,
  );
  const data = new Map(res.rows.map((r) => [r.service_id, Number(r.attain)]));
  // External services: attainment from the caller-observed edge metrics.
  const ext = await query<{ target_id: string; attain: string }>(
    `SELECT target_id,
            100 - coalesce(sum(error_count)::float8 / NULLIF(sum(call_count), 0) * 100, 0) AS attain
     FROM edge_metrics_1m
     WHERE bucket > now() - INTERVAL '30 days'
     GROUP BY target_id`,
  );
  for (const r of ext.rows) if (!data.has(r.target_id)) data.set(r.target_id, Number(r.attain));
  sloCache = { at: Date.now(), data };
  return data;
}

/** Pick a chart bucket size (seconds) giving roughly 40-60 points for a range. */
export function chartBucketSeconds(fromMs: number, toMs: number): number {
  const rangeSec = Math.max(60, (toMs - fromMs) / 1000);
  const candidates = [60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400];
  for (const c of candidates) {
    if (rangeSec / c <= 60) return c;
  }
  return 86400;
}
