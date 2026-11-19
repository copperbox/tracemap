import { gunzipSync, inflateSync } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPipeline, type Pipeline } from '../pipeline/index.js';
import { IngestError } from '../pipeline/pipeline.js';
import {
  decodeMetrics,
  decodeTraces,
  encodeMetricsResponse,
  encodeTraceResponse,
  type NormalizedResourceSpans,
} from './decode.js';

export interface OtlpRoutesOptions {
  /** Defaults to the process-wide pipeline. */
  pipeline?: Pipeline;
  /**
   * Largest body accepted after decompression, bytes. Defaults to the
   * server's bodyLimit, so a compressed body cannot expand past what an
   * uncompressed one may be.
   */
  maxBodyBytes?: number;
}

/** Thrown for anything wrong with the payload itself: answered with 400. */
class BadPayload extends Error {}

/** A body that decompresses past the limit: answered with 413. */
class TooLarge extends Error {}

function bodyOf(req: FastifyRequest, maxBytes: number): Buffer {
  const raw = req.body as Buffer | undefined;
  if (!raw) return Buffer.alloc(0);
  const enc = String(req.headers['content-encoding'] ?? '').toLowerCase();
  try {
    // maxOutputLength stops inflating once the limit is hit, so a small bomb cannot allocate the expansion.
    if (enc === 'gzip') return gunzipSync(raw, { maxOutputLength: maxBytes });
    if (enc === 'deflate') return inflateSync(raw, { maxOutputLength: maxBytes });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new TooLarge(`${enc} body expands past ${maxBytes} bytes`);
    }
    throw new BadPayload(`bad ${enc} body: ${(err as Error).message}`);
  }
  if (enc && enc !== 'identity') throw new BadPayload(`unsupported content-encoding ${enc}`);
  return raw;
}

async function decodeOr400<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof BadPayload || err instanceof TooLarge ? err : new BadPayload((err as Error).message);
  }
}

function spanCount(batches: NormalizedResourceSpans[]): number {
  let n = 0;
  for (const b of batches) n += b.spans.length;
  return n;
}

/**
 * OTLP/HTTP receiver per https://opentelemetry.io/docs/specs/otlp/
 * Accepts application/x-protobuf and application/json, optionally gzip.
 *
 * Status codes follow the OTLP retry rules: 400 only for a payload we cannot
 * decode and 413 for one too large (not retryable), 429 with Retry-After when
 * overloaded and 503 for an internal failure (both retryable). Once any span
 * of a batch has been counted the answer is 200, with partial success for
 * spans that failed, because a retry would count the rest twice. The handler
 * never awaits the database.
 */
export async function otlpRoutes(app: FastifyInstance, opts: OtlpRoutesOptions = {}): Promise<void> {
  const pipeline = opts.pipeline ?? getPipeline();
  const maxBodyBytes = opts.maxBodyBytes ?? app.initialConfig.bodyLimit ?? 1024 * 1024;

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

  /** 200, after the data was counted: nothing past this point may answer a retryable status. */
  const respond = async (
    req: FastifyRequest,
    reply: FastifyReply,
    encodeProto: () => Promise<Buffer>,
    partial?: { rejectedSpans: number; errorMessage: string },
  ) => {
    if (String(req.headers['content-type'] ?? '').includes('json')) {
      const ps = partial ? { rejectedSpans: String(partial.rejectedSpans), errorMessage: partial.errorMessage } : {};
      return reply.code(200).send({ partialSuccess: ps });
    }
    let body: Buffer;
    try {
      body = await encodeProto();
    } catch (err) {
      // Zero bytes is a valid empty response message.
      req.log.error({ err }, 'OTLP response encoding failed');
      body = Buffer.alloc(0);
    }
    return reply.code(200).type('application/x-protobuf').send(body);
  };

  const fail = (req: FastifyRequest, reply: FastifyReply, err: unknown, what: string) => {
    if (err instanceof TooLarge) {
      pipeline.countRequest('malformed');
      req.log.warn({ err: err.message }, `oversized OTLP ${what} export`);
      return reply.code(413).send({ error: 'payload too large' });
    }
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
    let batches: NormalizedResourceSpans[] = [];
    try {
      batches = await decodeOr400(async () => decodeTraces(bodyOf(req, maxBodyBytes), contentType));
      pipeline.ingestTraces(batches);
    } catch (err) {
      if (!(err instanceof IngestError) || !err.started) return fail(req, reply, err, 'trace');
      // Part of the batch is already counted: refuse the rest without inviting a retry.
      pipeline.countRequest('failed');
      req.log.error({ err: err.cause }, 'OTLP trace ingest failed part way');
      const partial = { rejectedSpans: spanCount(batches) - err.accepted, errorMessage: `ingest failed: ${err.message}` };
      return respond(req, reply, () => encodeTraceResponse(partial), partial);
    }
    pipeline.countRequest('ok');
    return respond(req, reply, encodeTraceResponse);
  });

  app.post('/v1/metrics', async (req, reply) => {
    const contentType = String(req.headers['content-type'] ?? 'application/x-protobuf');
    try {
      const points = await decodeOr400(async () => decodeMetrics(bodyOf(req, maxBodyBytes), contentType));
      // Metrics are not stored; they still tell us a service exists.
      const names = new Set<string>();
      for (const p of points) if (p.serviceName) names.add(p.serviceName);
      pipeline.noteMetricServices(names);
    } catch (err) {
      return fail(req, reply, err, 'metrics');
    }
    // Registering a service twice is harmless, so no partial-success care is needed here.
    pipeline.countRequest('ok');
    return respond(req, reply, encodeMetricsResponse);
  });
}
