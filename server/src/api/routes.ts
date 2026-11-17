import compress from '@fastify/compress';
import type { FastifyInstance } from 'fastify';
import { getLive } from '../live/index.js';
import { liveRoutes } from '../live/routes.js';
import { getPipeline } from '../pipeline/index.js';
import { topologyRoutes } from './topology.js';
import { serviceRoutes } from './services.js';
import { traceRoutes } from './traces.js';
import { teamRoutes } from './teams.js';
import { seriesRoutes } from './series.js';
import { errorRoutes } from './errors.js';

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // Routes that serve shared, already-compressed bodies or the event stream opt out per route.
  await app.register(compress, { threshold: 1024 });
  await app.register(liveRoutes);
  await app.register(topologyRoutes);
  await app.register(serviceRoutes);
  await app.register(traceRoutes);
  await app.register(teamRoutes);
  await app.register(seriesRoutes);
  await app.register(errorRoutes);

  app.get('/health', async () => {
    const pipeline = getPipeline().stats();
    const { snapshot, hub } = getLive();
    const snap = snapshot.latest;
    return {
      ok: true,
      services: snap?.structure.services.length ?? 0,
      spansLastMinute: pipeline.spans.lastMinute,
      pendingEdgeResolutions: pipeline.edges.pendingClients + pipeline.edges.pendingServers,
      pipeline,
      live: {
        seq: snap?.seq ?? 0,
        structureVersion: snap?.structure.version ?? 0,
        edges: snap?.structure.edges.length ?? 0,
        ...snapshot.stats,
        sse: hub.stats,
      },
    };
  });
}
