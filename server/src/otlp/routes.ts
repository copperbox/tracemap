import type { FastifyInstance } from 'fastify';
import {
  decodeMetrics,
  decodeTraces,
  encodeMetricsResponse,
  encodeTraceResponse,
} from './decode.js';
import { ingestMetrics, ingestTraces } from './ingest.js';

/**
 * OTLP/HTTP receiver per https://opentelemetry.io/docs/specs/otlp/
 * Accepts application/x-protobuf and application/json on the standard paths.
 */
export async function otlpRoutes(app: FastifyInstance): Promise<void> {
  // Keep bodies raw; decoding depends on content-type.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/v1/traces', async (req, reply) => {
    const contentType = req.headers['content-type'] ?? 'application/x-protobuf';
    try {
      const batches = await decodeTraces(req.body as Buffer, contentType);
      const stats = await ingestTraces(batches);
      req.log.debug({ spans: stats.spans, edges: stats.edgeObservations }, 'ingested traces');
      if (contentType.includes('json')) {
        return reply.code(200).send({ partialSuccess: {} });
      }
      return reply.code(200).type('application/x-protobuf').send(await encodeTraceResponse());
    } catch (err) {
      req.log.warn({ err }, 'bad OTLP trace export');
      return reply.code(400).send({ error: 'invalid OTLP payload' });
    }
  });

  app.post('/v1/metrics', async (req, reply) => {
    const contentType = req.headers['content-type'] ?? 'application/x-protobuf';
    try {
      const points = await decodeMetrics(req.body as Buffer, contentType);
      await ingestMetrics(points);
      if (contentType.includes('json')) {
        return reply.code(200).send({ partialSuccess: {} });
      }
      return reply.code(200).type('application/x-protobuf').send(await encodeMetricsResponse());
    } catch (err) {
      req.log.warn({ err }, 'bad OTLP metrics export');
      return reply.code(400).send({ error: 'invalid OTLP payload' });
    }
  });
}
