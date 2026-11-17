import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { getPipeline } from '../pipeline/index.js';
import { topologyRoutes } from './topology.js';
import { serviceRoutes } from './services.js';
import { traceRoutes } from './traces.js';
import { teamRoutes } from './teams.js';
import { seriesRoutes } from './series.js';
import { errorRoutes } from './errors.js';

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  await app.register(topologyRoutes);
  await app.register(serviceRoutes);
  await app.register(traceRoutes);
  await app.register(teamRoutes);
  await app.register(seriesRoutes);
  await app.register(errorRoutes);

  app.get('/health', async () => {
    const svc = await query<{ n: string }>('SELECT count(*) AS n FROM services');
    const pipeline = getPipeline().stats();
    return {
      ok: true,
      services: Number(svc.rows[0].n),
      spansLastMinute: pipeline.spans.lastMinute,
      pendingEdgeResolutions: pipeline.edges.pendingClients + pipeline.edges.pendingServers,
      pipeline,
    };
  });
}
