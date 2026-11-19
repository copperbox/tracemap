import type pg from 'pg';

/**
 * The SQL orchestration behind reversible service merges, kept out of the route
 * so it can run against a transaction client and be unit-tested with a stub.
 *
 * A merge folds `sourceId` into `targetId`: future telemetry is aliased, the
 * edge graph is folded, and the source service row is deleted. Every step is
 * recorded in `service_merges` so `unmergeServices` can put it all back.
 *
 * Telemetry is never rewritten. Rollups and kept traces stay under the id they
 * were recorded with; reads expand a canonical id to its aliases and group by
 * canonical id (api/aliases.ts), so dropping the alias on unmerge is enough to
 * split the history back out. Both operations touch only catalog tables.
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
  await q(
    `INSERT INTO service_merges (source_id, target_id, source_service, edges_snapshot)
     VALUES ($1, $2, $3, $4)`,
    [sourceId, targetId, jsonbParam(sourceService), jsonbParam(edgesSnapshot)],
  );
  // Alias future telemetry arriving under the old name to the canonical service.
  await q(
    `INSERT INTO service_aliases (alias, service_id) VALUES ($1, $2)
     ON CONFLICT (alias) DO UPDATE SET service_id = $2`,
    [sourceId, targetId],
  );
  // (Defensive: a valid source has no aliases of its own -- the chain guard in
  // the route ensures it -- but re-point any just in case.)
  await q('UPDATE service_aliases SET service_id = $2 WHERE service_id = $1', [sourceId, targetId]);

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
 * Undo the merge of `sourceId` into `targetId`, restoring the source service,
 * its alias-free history and the pre-merge edges. Returns false (writing nothing) when no
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
  // Dropping the alias is what splits the history back out: reads stop folding the source id in.
  await q('DELETE FROM service_aliases WHERE alias = $1', [sourceId]);

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
