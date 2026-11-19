import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { bigintToSpanHex, hexToUuid, uuidToHex } from '../rollup/schema.js';
import { KEPT_TABLES } from '../rollup/tiers.js';
import { aliases } from './aliases.js';
import { parseIntParam, parseRange } from './range.js';

/** A kept trace's spans start shortly before its row time and may arrive late; read this much around it. */
const SPAN_WINDOW_BEFORE_MS = 60_000;
const SPAN_WINDOW_AFTER_MS = 3_600_000;
const MAX_SPANS = 2000;

/**
 * Traces come from the kept sample (errors, slow, baseline under a span
 * budget), not every trace: list items carry the `reason` it was kept for.
 * Trace ids are 32-hex on the wire, uuid in the database.
 */
export async function traceRoutes(app: FastifyInstance): Promise<void> {
  // Recent kept traces touching a service (or a service merged into it) within a time range.
  app.get('/services/:id/traces', async (req) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as Record<string, unknown>;
    const { fromMs, toMs } = parseRange(q);
    const limit = parseIntParam(q, 'limit', { def: 25, min: 1, max: 50 });
    // Optional: restrict to traces where this operation errored on the service.
    const op = typeof q.op === 'string' && q.op ? q.op : null;

    const res = await query<{
      trace_id: string;
      time: Date;
      root_service: string | null;
      root_operation: string | null;
      duration_ms: number;
      span_count: number;
      has_error: boolean;
      reason: string;
    }>(
      `WITH hits AS (
         SELECT DISTINCT ON (time, trace_id) time, trace_id
         FROM kept_trace_services
         WHERE service_id = ANY($1) AND time >= $2 AND time < $3
           AND ($5::text IS NULL OR $5 = ANY(error_ops))
         ORDER BY time DESC, trace_id
         LIMIT $4
       )
       SELECT t.trace_id::text, t.time, t.root_service, t.root_operation, t.duration_ms, t.span_count, t.has_error, t.reason
       FROM hits h JOIN kept_traces t ON t.trace_id = h.trace_id AND t.time = h.time
       ORDER BY t.time DESC`,
      [aliases.expand(id), new Date(fromMs), new Date(toMs), limit, op],
    );
    return {
      traces: res.rows.map((r) => ({
        traceId: uuidToHex(r.trace_id),
        rootOperation: r.root_operation ?? '',
        rootService: r.root_service ? aliases.canonical(r.root_service) : '',
        durationMs: Number(r.duration_ms),
        time: r.time,
        spanCount: r.span_count,
        status: r.has_error ? 'error' : 'ok',
        reason: r.reason,
      })),
    };
  });

  // Full trace for the waterfall.
  app.get('/traces/:traceId', async (req, reply) => {
    const traceId = (req.params as { traceId: string }).traceId.toLowerCase();
    const uuid = /^[0-9a-f]{32}$/.test(traceId) ? hexToUuid(traceId) : null;
    if (!uuid) return reply.code(404).send({ error: 'unknown trace' });

    // kept_traces gives the time range, so kept_spans is read from a few chunks only.
    const head = await query<{ time: Date; reason: string }>(
      `SELECT time, reason FROM kept_traces WHERE trace_id = $1 ORDER BY time LIMIT 1`,
      [uuid],
    );
    const at = head.rows[0]?.time.getTime();
    const [lo, hi] =
      at != null
        ? [new Date(at - SPAN_WINDOW_BEFORE_MS), new Date(at + SPAN_WINDOW_AFTER_MS)]
        : [new Date(Date.now() - KEPT_TABLES.retentionMs), new Date(Date.now() + 60_000)];
    const spans = await query<{
      span_id: string;
      parent_span_id: string | null;
      service_id: string;
      name: string;
      kind: number;
      time: Date;
      duration_ms: number;
      is_error: boolean;
      attrs: Record<string, unknown> | null;
    }>(
      `SELECT span_id::text, parent_span_id::text, service_id, name, kind, time, duration_ms, is_error, attrs
       FROM kept_spans WHERE trace_id = $1 AND time >= $2 AND time < $3
       ORDER BY time ASC LIMIT ${MAX_SPANS}`,
      [uuid, lo, hi],
    );
    if (!spans.rowCount) return reply.code(404).send({ error: 'unknown trace' });
    // Late spans are appended without updating kept_traces.span_count, so count what is here.
    return {
      traceId,
      reason: head.rows[0]?.reason ?? null,
      spanCount: spans.rowCount,
      spans: spans.rows.map((s) => ({
        spanId: bigintToSpanHex(s.span_id),
        parentSpanId: s.parent_span_id == null ? null : bigintToSpanHex(s.parent_span_id),
        serviceId: aliases.canonical(s.service_id),
        name: s.name,
        kind: s.kind,
        startTime: s.time,
        durationMs: Number(s.duration_ms),
        isError: s.is_error,
        attrs: s.attrs ?? {},
      })),
    };
  });
}
