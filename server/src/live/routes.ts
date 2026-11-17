import type { FastifyInstance } from 'fastify';
import { NO_COMPRESS, sendEncoded } from './encoded.js';
import { SNAPSHOT_INTERVAL_MS, getLive } from './index.js';
import { formatEvent } from './sse.js';

/**
 * GET /live            SSE: hello, structure and metrics notices, heartbeat comments
 * GET /live/structure  LiveStructure JSON, ETag = version
 * GET /live/metrics    latest binary frame (see frame.ts)
 */
export async function liveRoutes(app: FastifyInstance): Promise<void> {
  app.get('/live', NO_COMPRESS, async (req, reply) => {
    const { snapshot, hub } = getLive();
    const snap = await snapshot.current();
    reply.hijack();
    // Hijacked replies skip hooks; carry over headers plugins (CORS) already set.
    hub.add(
      reply.raw,
      reply.getHeaders() as Record<string, string>,
      formatEvent('hello', { structureVersion: snap.structure.version, seq: snap.seq, intervalMs: SNAPSHOT_INTERVAL_MS }),
    );
  });

  app.get('/live/structure', NO_COMPRESS, async (req, reply) => {
    const snap = await getLive().snapshot.current();
    return sendEncoded(req, reply, snap.structureBody);
  });

  app.get('/live/metrics', NO_COMPRESS, async (req, reply) => {
    const snap = await getLive().snapshot.current();
    return sendEncoded(req, reply, snap.frame);
  });
}
