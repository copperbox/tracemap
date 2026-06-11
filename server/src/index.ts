import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { otlpRoutes } from './otlp/routes.js';
import { registry } from './otlp/registry.js';
import { startIngestLoop } from './otlp/ingest.js';
import { apiRoutes } from './api/routes.js';

async function main(): Promise<void> {
  await migrate();
  await registry.load();
  startIngestLoop();

  // OTLP/HTTP collector (standard port 4318).
  const collector = Fastify({ logger: { level: 'warn' }, bodyLimit: 32 * 1024 * 1024 });
  await collector.register(otlpRoutes);
  await collector.listen({ port: config.otlpPort, host: '0.0.0.0' });

  // Query/management API for the dashboard.
  const api = Fastify({ logger: { level: 'warn' } });
  await api.register(cors, { origin: true });
  await api.register(apiRoutes, { prefix: '/api' });
  await api.listen({ port: config.port, host: '0.0.0.0' });

  console.log(`Deptrace collector listening on :${config.otlpPort} (OTLP/HTTP)`);
  console.log(`Deptrace API listening on :${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
