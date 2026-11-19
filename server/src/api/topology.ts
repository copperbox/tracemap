import type { FastifyInstance } from 'fastify';
import { NO_COMPRESS, sendEncoded } from '../live/encoded.js';
import { getLive } from '../live/index.js';

/**
 * GET /api/topology
 * The full live service map in its original JSON shape: every known service
 * and learned edge with current (or last-known) performance. Built from the
 * live snapshot and serialized once per snapshot for all viewers.
 */
export async function topologyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/topology', NO_COMPRESS, async (req, reply) => {
    const snap = await getLive().snapshot.current();
    return sendEncoded(req, reply, snap.topology());
  });
}
