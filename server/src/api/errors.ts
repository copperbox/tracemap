import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { aggregateErrors, type ErrorSpanRow } from './errorSignature.js';
import { parseRange } from './range.js';

/** Raw error-span shape as it comes back from the spans table. */
type Row = { operation: string; attrs: Record<string, unknown> | null; http_status: number | null };

function toRows(rows: Row[]): ErrorSpanRow[] {
  return rows.map((r) => ({ operation: r.operation, attrs: r.attrs, httpStatus: r.http_status }));
}

/**
 * Top erroring operations -- and the actual errors seen -- for a selected node
 * or edge. Error spans within the range (`?from=&to=`, defaulting to the last
 * 24h) are grouped by operation then by error signature. Surfaced both in the
 * map inspector drawer and on the full service page.
 */
export async function errorRoutes(app: FastifyInstance): Promise<void> {
  // Errors a service is producing, by its handled operation.
  app.get('/services/:id/errors', async (req) => {
    const id = (req.params as { id: string }).id;
    const { fromMs, toMs } = parseRange(req.query as Record<string, unknown>);
    const from = new Date(fromMs);
    const to = new Date(toMs);

    // External services emit no telemetry of their own; surface the errors
    // their callers recorded against them instead.
    const svc = await query<{ is_external: boolean }>(
      'SELECT is_external FROM services WHERE id = $1',
      [id],
    );
    const isExternal = svc.rows[0]?.is_external ?? false;

    const rows = isExternal
      ? await query<Row>(
          `SELECT name AS operation, attrs, http_status FROM spans
           WHERE peer_service_id = $1 AND is_error AND kind IN (3, 4)
             AND time >= $2 AND time < $3
           ORDER BY time DESC LIMIT 2000`,
          [id, from, to],
        )
      : await query<Row>(
          `SELECT name AS operation, attrs, http_status FROM spans
           WHERE service_id = $1 AND is_error AND (kind IN (2, 5) OR is_root)
             AND time >= $2 AND time < $3
           ORDER BY time DESC LIMIT 2000`,
          [id, from, to],
        );

    return { operations: aggregateErrors(toRows(rows.rows)) };
  });

  // Errors seen on one dependency edge, from the caller's client spans.
  app.get('/edges/:source/:target/errors', async (req) => {
    const { source, target } = req.params as { source: string; target: string };
    const { fromMs, toMs } = parseRange(req.query as Record<string, unknown>);
    const rows = await query<Row>(
      `SELECT name AS operation, attrs, http_status FROM spans
       WHERE service_id = $1 AND peer_service_id = $2 AND is_error AND kind IN (3, 4)
         AND time >= $3 AND time < $4
       ORDER BY time DESC LIMIT 2000`,
      [source, target, new Date(fromMs), new Date(toMs)],
    );
    return { operations: aggregateErrors(toRows(rows.rows)) };
  });
}
