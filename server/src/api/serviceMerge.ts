import type { FastifyInstance } from 'fastify';
import { pool, query } from '../db/pool.js';
import { registry } from '../otlp/registry.js';

/** POST /services/:id/merge: fold another discovered service into this one. */
export async function serviceMergeRoutes(app: FastifyInstance): Promise<void> {
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
}
