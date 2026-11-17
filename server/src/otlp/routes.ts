import { gunzipSync, inflateSync } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPipeline, type Pipeline } from '../pipeline/index.js';
import {
  decodeMetrics,
  decodeTraces,
  encodeMetricsResponse,
  encodeTraceResponse,
} from './decode.js';

export interface OtlpRoutesOptions {
  /** Defaults to the process-wide pipeline. */
  pipeline?: Pipeline;
}

/** Thrown for anything wrong with the payload itself: answered with 400. */
class BadPayload extends Error {}

function bodyOf(req: FastifyRequest): Buffer {
  const raw = req.body as Buffer | undefined;
  if (!raw) return Buffer.alloc(0);
  const enc = String(req.headers['content-encoding'] ?? '').toLowerCase();
  try {
    if (enc === 'gzip') return gunzipSync(raw);
    if (enc === 'deflate') return inflateSync(raw);
  } catch (err) {
    throw new BadPayload(`bad ${enc} body: ${(err as Error).message}`);
  }
  if (enc && enc !== 'identity') throw new BadPayload(`unsupported content-encoding ${enc}`);
  return raw;
}

async function decodeOr400<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof BadPayload ? err : new BadPayload((err as Error).message);
  }
}

/**
 * OTLP/HTTP receiver per https://opentelemetry.io/docs/specs/otlp/
 * Accepts application/x-protobuf and application/json, optionally gzip.
 *
 * Status codes follow the OTLP retry rules: 400 only for a payload we cannot
 * decode (not retryable), 429 with Retry-After when overloaded and 503 for an
 * internal failure (both retryable). The handler never awaits the database.
 */
export async function otlpRoutes(app: FastifyInstance, opts: OtlpRoutesOptions = {}): Promise<void> {
  const pipeline = opts.pipeline ?? getPipeline();

  // Keep bodies raw; decoding depends on content-type.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // Shed load before reading the body.
  app.addHook('onRequest', async (_req, reply) => {
    const gate = pipeline.gate();
    if (!gate.ok) {
      pipeline.countRequest('overloaded');
      reply.header('Retry-After', String(gate.retryAfterSec));
      return reply.code(429).send({ error: 'collector overloaded', reason: gate.reason });
    }
    pipeline.inflight++;
    reply.raw.once('close', () => pipeline.inflight--);
  });

  const respond = async (req: FastifyRequest, reply: FastifyReply, encodeProto: () => Promise<Buffer>) => {
    pipeline.countRequest('ok');
    if (String(req.headers['content-type'] ?? '').includes('json')) {
      return reply.code(200).send({ partialSuccess: {} });
    }
    return reply.code(200).type('application/x-protobuf').send(await encodeProto());
  };

  const fail = (req: FastifyRequest, reply: FastifyReply, err: unknown, what: string) => {
    if (err instanceof BadPayload) {
      pipeline.countRequest('malformed');
      req.log.warn({ err: err.message }, `bad OTLP ${what} export`);
      return reply.code(400).send({ error: 'invalid OTLP payload' });
    }
    pipeline.countRequest('failed');
    req.log.error({ err }, `OTLP ${what} ingest failed`);
    return reply.code(503).header('Retry-After', '5').send({ error: 'collector unavailable' });
  };

  app.post('/v1/traces', async (req, reply) => {
    const contentType = String(req.headers['content-type'] ?? 'application/x-protobuf');
    try {
      const batches = await decodeOr400(async () => decodeTraces(bodyOf(req), contentType));
      pipeline.ingestTraces(batches);
      return await respond(req, reply, encodeTraceResponse);
    } catch (err) {
      return fail(req, reply, err, 'trace');
    }
  });

  app.post('/v1/metrics', async (req, reply) => {
    const contentType = String(req.headers['content-type'] ?? 'application/x-protobuf');
    try {
      const points = await decodeOr400(async () => decodeMetrics(bodyOf(req), contentType));
      // Metrics are not stored; they still tell us a service exists.
      const names = new Set<string>();
      for (const p of points) if (p.serviceName) names.add(p.serviceName);
      pipeline.noteMetricServices(names);
      return await respond(req, reply, encodeMetricsResponse);
    } catch (err) {
      return fail(req, reply, err, 'metrics');
    }
  });
}
