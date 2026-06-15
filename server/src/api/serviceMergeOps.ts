import type pg from 'pg';
import { query } from '../db/pool.js';

/**
 * The SQL orchestration behind reversible service merges, kept out of the route
 * so it can run against a transaction client and be unit-tested with a stub.
 *
 * A merge folds `sourceId` into `targetId`: future telemetry is aliased, all
 * historical telemetry is re-pointed and tagged with the merge id, the edge
 * graph is folded, and the source service row is deleted. Every step is recorded
 * in `service_merges` so `unmergeServices` can put it all back.
 */
export type Runner = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;

/** Columns of the `services` row, in the order used to snapshot and restore it. */
const SERVICE_COLS =
  'id, display_name, description, type, team_id, runtime, region, is_external, slo_target, first_seen, last_seen';
const SERVICE_RECORD =
  'id text, display_name text, description text, type text, team_id int, runtime text, region text, ' +
  'is_external boolean, slo_target double precision, first_seen timestamptz, last_seen timestamptz';

/**
 * Serialize a snapshot payload for a jsonb parameter. node-postgres sends a JS
 * array as a Postgres array literal (`{...}`), not JSON, which is invalid input
 * for a jsonb column -- so we stringify objects and arrays ourselves and let pg
 * pass them as a json text literal. (null/undefined -> SQL NULL.)
 */
const jsonbParam = (value: unknown): string | null => (value == null ? null : JSON.stringify(value));

/** Fold `sourceId` into `targetId`. Caller owns the surrounding transaction. */
export async function mergeServices(q: Runner, targetId: string, sourceId: string): Promise<void> {
  // Snapshot what the unmerge will need to restore, before anything is destroyed.
  const svc = await q(`SELECT to_jsonb(s.*) AS row FROM services s WHERE id = $1`, [sourceId]);
  const sourceService = svc.rows[0]?.row ?? null;
  const edges = await q(
    `SELECT COALESCE(jsonb_agg(to_jsonb(e.*)), '[]'::jsonb) AS rows FROM edges e
     WHERE e.source_id IN ($1, $2) OR e.target_id IN ($1, $2)`,
    [sourceId, targetId],
  );
  const edgesSnapshot = edges.rows[0].rows;
  const merge = await q(
    `INSERT INTO service_merges (source_id, target_id, source_service, edges_snapshot)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [sourceId, targetId, jsonbParam(sourceService), jsonbParam(edgesSnapshot)],
  );
  const mergeId = merge.rows[0].id as number;

  // Alias future telemetry arriving under the old name to the canonical service.
  await q(
    `INSERT INTO service_aliases (alias, service_id) VALUES ($1, $2)
     ON CONFLICT (alias) DO UPDATE SET service_id = $2`,
    [sourceId, targetId],
  );
  // (Defensive: a valid source has no aliases of its own -- the chain guard in
  // the route ensures it -- but re-point any just in case.)
  await q('UPDATE service_aliases SET service_id = $2 WHERE service_id = $1', [sourceId, targetId]);

  // Re-point historical telemetry, tagging each moved row with this merge.
  await q('UPDATE spans SET service_id = $2, svc_merge = $3 WHERE service_id = $1', [sourceId, targetId, mergeId]);
  await q('UPDATE spans SET peer_service_id = $2, peer_merge = $3 WHERE peer_service_id = $1', [sourceId, targetId, mergeId]);
  await q('UPDATE edge_events SET source_id = $2, src_merge = $3 WHERE source_id = $1', [sourceId, targetId, mergeId]);
  await q('UPDATE edge_events SET target_id = $2, tgt_merge = $3 WHERE target_id = $1', [sourceId, targetId, mergeId]);

  // Fold learned edges into the target (drop any that become self-edges).
  await q(
    `INSERT INTO edges (source_id, target_id, first_seen, last_seen, sample_count, manual)
     SELECT $2, target_id, first_seen, last_seen, sample_count, manual FROM edges WHERE source_id = $1
     ON CONFLICT (source_id, target_id) DO UPDATE SET
       sample_count = edges.sample_count + EXCLUDED.sample_count,
       first_seen = LEAST(edges.first_seen, EXCLUDED.first_seen),
       last_seen = GREATEST(edges.last_seen, EXCLUDED.last_seen)`,
    [sourceId, targetId],
  );
  await q(
    `INSERT INTO edges (source_id, target_id, first_seen, last_seen, sample_count, manual)
     SELECT source_id, $2, first_seen, last_seen, sample_count, manual FROM edges WHERE target_id = $1
     ON CONFLICT (source_id, target_id) DO UPDATE SET
       sample_count = edges.sample_count + EXCLUDED.sample_count,
       first_seen = LEAST(edges.first_seen, EXCLUDED.first_seen),
       last_seen = GREATEST(edges.last_seen, EXCLUDED.last_seen)`,
    [sourceId, targetId],
  );
  await q('DELETE FROM edges WHERE source_id = $1 OR target_id = $1', [sourceId]);
  await q('DELETE FROM edges WHERE source_id = target_id', []);
  await q('DELETE FROM services WHERE id = $1', [sourceId]);
}

/**
 * Undo the merge of `sourceId` into `targetId`, restoring the source service and
 * the telemetry/edges that merge moved. Returns false (writing nothing) when no
 * reversible merge is recorded. Caller owns the surrounding transaction.
 */
export async function unmergeServices(q: Runner, targetId: string, sourceId: string): Promise<boolean> {
  const m = await q(
    'SELECT id, source_service, edges_snapshot FROM service_merges WHERE source_id = $1 AND target_id = $2',
    [sourceId, targetId],
  );
  if (!m.rowCount) return false;
  const { id: mergeId, source_service: sourceService, edges_snapshot: edgesSnapshot } = m.rows[0];

  // Recreate the folded-in service first so the edge foreign keys resolve.
  await q(
    `INSERT INTO services (${SERVICE_COLS})
     SELECT ${SERVICE_COLS} FROM jsonb_to_record($1::jsonb) AS x(${SERVICE_RECORD})
     ON CONFLICT (id) DO NOTHING`,
    [jsonbParam(sourceService)],
  );
  // Drop the alias and put the re-pointed telemetry back under the source id.
  await q('DELETE FROM service_aliases WHERE alias = $1', [sourceId]);
  await q('UPDATE spans SET service_id = $1, svc_merge = NULL WHERE svc_merge = $2', [sourceId, mergeId]);
  await q('UPDATE spans SET peer_service_id = $1, peer_merge = NULL WHERE peer_merge = $2', [sourceId, mergeId]);
  await q('UPDATE edge_events SET source_id = $1, src_merge = NULL WHERE src_merge = $2', [sourceId, mergeId]);
  await q('UPDATE edge_events SET target_id = $1, tgt_merge = NULL WHERE tgt_merge = $2', [sourceId, mergeId]);

  // Restore the pre-merge edge graph from the snapshot (skip any edge whose other
  // endpoint has since been merged away).
  await q('DELETE FROM edges WHERE source_id IN ($1, $2) OR target_id IN ($1, $2)', [sourceId, targetId]);
  await q(
    `INSERT INTO edges (source_id, target_id, first_seen, last_seen, sample_count, manual)
     SELECT x.source_id, x.target_id, x.first_seen, x.last_seen, x.sample_count, x.manual
     FROM jsonb_to_recordset($1::jsonb)
       AS x(source_id text, target_id text, first_seen timestamptz, last_seen timestamptz, sample_count bigint, manual boolean)
     WHERE EXISTS (SELECT 1 FROM services WHERE id = x.source_id)
       AND EXISTS (SELECT 1 FROM services WHERE id = x.target_id)
     ON CONFLICT (source_id, target_id) DO NOTHING`,
    [jsonbParam(edgesSnapshot)],
  );
  await q('DELETE FROM service_merges WHERE id = $1', [mergeId]);
  return true;
}

/**
 * Rebuild the per-minute aggregates over the affected window so chart history
 * follows a merge/unmerge. Runs as a fire-and-forget background step -- it can
 * take many seconds over a 30-day window and must never block the HTTP response.
 */
export async function refreshMergeAggregates(): Promise<void> {
  for (const cagg of ['service_op_metrics_1m', 'edge_metrics_1m', 'edge_op_metrics_1m']) {
    await query(
      `CALL refresh_continuous_aggregate('${cagg}', now() - INTERVAL '30 days', now())`,
    ).catch((err) => console.warn(`cagg refresh ${cagg} failed:`, err.message));
  }
}
