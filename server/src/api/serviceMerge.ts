import type { FastifyInstance } from 'fastify';
import { pool, query } from '../db/pool.js';
import { registry } from '../otlp/registry.js';
import { getLive } from '../live/index.js';
import { aliases } from './aliases.js';
import { mergeServices, unmergeServices } from './serviceMergeOps.js';

/**
 * After a merge or unmerge: the ingest registry resolves new telemetry, the
 * read-side alias map regroups history, and the snapshot re-reads the catalog.
 */
async function afterMergeChange(): Promise<void> {
  await Promise.all([registry.load(), aliases.load(query)]);
  await getLive().snapshot.refreshNow();
}

/** Reversible service merges: POST /services/:id/merge and /unmerge. */
export async function serviceMergeRoutes(app: FastifyInstance): Promise<void> {
  // ---- fold another discovered service into this one ----
  app.post('/services/:id/merge', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { sourceId } = (req.body ?? {}) as { sourceId?: string };
    if (!sourceId || sourceId === id) return reply.code(400).send({ error: 'sourceId required' });

    const both = await query('SELECT id FROM services WHERE id = ANY($1)', [[id, sourceId]]);
    if (both.rowCount !== 2) return reply.code(404).send({ error: 'unknown service' });

    // A service that already has duplicates folded into it can't itself be merged
    // elsewhere, or its inbound merges would no longer be reversible.
    const hasMerges = await query('SELECT 1 FROM service_merges WHERE target_id = $1 LIMIT 1', [sourceId]);
    if (hasMerges.rowCount) {
      return reply
        .code(409)
        .send({ error: `${sourceId} has its own merged duplicates; unmerge those before merging it elsewhere` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await mergeServices((sql, params) => client.query(sql, params), id, sourceId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await afterMergeChange();
    return { ok: true, mergedInto: id, alias: sourceId };
  });

  // ---- undo a previous merge, splitting the duplicate back out ----
  app.post('/services/:id/unmerge', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { sourceId } = (req.body ?? {}) as { sourceId?: string };
    if (!sourceId) return reply.code(400).send({ error: 'sourceId required' });

    const client = await pool.connect();
    let undone = false;
    try {
      await client.query('BEGIN');
      undone = await unmergeServices((sql, params) => client.query(sql, params), id, sourceId);
      await client.query(undone ? 'COMMIT' : 'ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    if (!undone) return reply.code(404).send({ error: 'no reversible merge found for this duplicate' });

    await afterMergeChange();
    return { ok: true, splitOut: sourceId };
  });
}
