import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { edgeResolver } from '../otlp/ingest.js';
import { topologyRoutes } from './topology.js';
import { serviceRoutes } from './services.js';
import { traceRoutes } from './traces.js';
import { teamRoutes } from './teams.js';
import { seriesRoutes } from './series.js';

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  await app.register(topologyRoutes);
  await app.register(serviceRoutes);
  await app.register(traceRoutes);
  await app.register(teamRoutes);
  await app.register(seriesRoutes);

  app.get('/health', async () => {
    const [svc, spans] = await Promise.all([
      query<{ n: string }>('SELECT count(*) AS n FROM services'),
      query<{ n: string }>(
        `SELECT count(*) AS n FROM spans WHERE time > now() - INTERVAL '1 minute'`,
      ),
    ]);
    return {
      ok: true,
      services: Number(svc.rows[0].n),
      spansLastMinute: Number(spans.rows[0].n),
      pendingEdgeResolutions: edgeResolver.pendingCount,
    };
  });
}
