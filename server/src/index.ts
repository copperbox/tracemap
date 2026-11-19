import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { closePools } from './db/pool.js';
import { otlpRoutes } from './otlp/routes.js';
import { registry } from './otlp/registry.js';
import { getPipeline } from './pipeline/index.js';
import { apiRoutes } from './api/routes.js';
import { startLive, stopLive } from './live/index.js';

async function main(): Promise<void> {
  await migrate();
  await registry.load();
  const pipeline = getPipeline();
  await pipeline.start();

  // OTLP/HTTP collector (standard port 4318).
  const collector = Fastify({ logger: { level: 'warn' }, bodyLimit: 32 * 1024 * 1024 });
  await collector.register(otlpRoutes, { pipeline });
  await collector.listen({ port: config.otlpPort, host: '0.0.0.0' });

  await startLive();

  // Query/management API for the dashboard.
  const api = Fastify({ logger: { level: 'warn' } });
  await api.register(cors, { origin: true });
  await api.register(apiRoutes, { prefix: '/api' });
  await api.listen({ port: config.port, host: '0.0.0.0' });

  console.log(`TraceMap collector ${pipeline.collectorId} listening on :${config.otlpPort} (OTLP/HTTP)`);
  console.log(`TraceMap API listening on :${config.port}`);

  // Graceful shutdown: stop taking spans, then flush cells, kept traces and the catalog.
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: flushing and shutting down`);
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    try {
      await collector.close();
      await pipeline.shutdown();
      await stopLive();
      await api.close();
      await closePools();
    } catch (err) {
      console.error('shutdown error:', err);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
