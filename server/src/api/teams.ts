import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';

export async function teamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/teams', async () => {
    const res = await query<{ id: number; name: string; service_count: string }>(
      `SELECT t.id, t.name, count(s.id) AS service_count
       FROM teams t LEFT JOIN services s ON s.team_id = t.id
       GROUP BY t.id ORDER BY t.name`,
    );
    return { teams: res.rows.map((r) => ({ id: r.id, name: r.name, serviceCount: Number(r.service_count) })) };
  });

  app.post('/teams', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name?.trim()) return reply.code(400).send({ error: 'name required' });
    const res = await query<{ id: number; name: string }>(
      `INSERT INTO teams (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name`,
      [name.trim()],
    );
    return res.rows[0];
  });
}
