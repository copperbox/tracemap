import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';

/** Service edits: metadata patch and manual dependency association. */
export async function serviceEditRoutes(app: FastifyInstance): Promise<void> {
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
