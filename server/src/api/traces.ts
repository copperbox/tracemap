import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { rangeMs } from './range.js';

export async function traceRoutes(app: FastifyInstance): Promise<void> {
  // Recent traces touching a service within a time range.
  app.get('/services/:id/traces', async (req) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as Record<string, unknown>;
    const { fromMs, toMs } = rangeMs(q);
    const limit = Math.min(50, Number(q.limit ?? 25));

    const traceIds = await query<{ trace_id: string; latest: Date }>(
      `WITH recent AS (
         SELECT trace_id, time FROM spans
         WHERE service_id = $1 AND time >= $2 AND time < $3
         ORDER BY time DESC LIMIT 2000
       )
       SELECT trace_id, max(time) AS latest FROM recent
       GROUP BY trace_id ORDER BY latest DESC LIMIT $4`,
      [id, new Date(fromMs), new Date(toMs), limit],
    );
    if (!traceIds.rowCount) return { traces: [] };

    const ids = traceIds.rows.map((r) => r.trace_id);
    const roots = await query<{
      trace_id: string;
      name: string;
      service_id: string;
      duration_ms: number;
      time: Date;
      span_count: string;
      has_error: boolean;
    }>(
      `SELECT DISTINCT ON (s.trace_id)
              s.trace_id, s.name, s.service_id, s.duration_ms, s.time,
              c.span_count, c.has_error
       FROM spans s
       JOIN (
         SELECT trace_id, count(*) AS span_count, bool_or(is_error) AS has_error
         FROM spans WHERE trace_id = ANY($1) GROUP BY trace_id
       ) c ON c.trace_id = s.trace_id
       WHERE s.trace_id = ANY($1)
       ORDER BY s.trace_id, s.is_root DESC, s.time ASC`,
      [ids],
    );

    const order = new Map(ids.map((t, i) => [t, i]));
    return {
      traces: roots.rows
        .sort((a, b) => (order.get(a.trace_id) ?? 0) - (order.get(b.trace_id) ?? 0))
        .map((r) => ({
          traceId: r.trace_id,
          rootOperation: r.name,
          rootService: r.service_id,
          durationMs: Number(r.duration_ms),
          time: r.time,
          spanCount: Number(r.span_count),
          status: r.has_error ? 'error' : 'ok',
        })),
    };
  });

  // Full trace for the waterfall.
  app.get('/traces/:traceId', async (req, reply) => {
    const traceId = (req.params as { traceId: string }).traceId;
    const spans = await query<{
      trace_id: string;
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
      `SELECT trace_id, span_id, parent_span_id, service_id, name, kind, time,
              duration_ms, is_error, attrs
       FROM spans WHERE trace_id = $1 ORDER BY time ASC LIMIT 500`,
      [traceId],
    );
    if (!spans.rowCount) return reply.code(404).send({ error: 'unknown trace' });
    return {
      traceId,
      spans: spans.rows.map((s) => ({
        spanId: s.span_id,
        parentSpanId: s.parent_span_id,
        serviceId: s.service_id,
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
