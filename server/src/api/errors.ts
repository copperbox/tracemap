import type { FastifyInstance } from 'fastify';
import { getLive } from '../live/index.js';
import type { ReadQuery } from '../rollup/read.js';
import { aliases } from './aliases.js';
import { aggregateErrorRollups } from './errorRollup.js';
import { chartBucketSeconds } from './metrics.js';
import { parseRange } from './range.js';

/** Exact error counts by operation and signature from an error rollup, with a sample trace each. */
async function errorBreakdown(q: Omit<ReadQuery, 'groupBy' | 'bucketMs'>) {
  const reader = getLive().reader;
  const rows = await reader.totals(
    { ...q, bucketMs: chartBucketSeconds(q.fromMs, q.toMs) * 1000, groupBy: ['operation', 'code', 'message'] },
    aliases.canonical,
  );
  return {
    operations: aggregateErrorRollups(
      rows.map((r) => ({ operation: r.keys[0], code: r.keys[1], message: r.keys[2], n: r.n, sample: r.sample })),
    ),
  };
}

/**
 * Top erroring operations -- and the actual errors seen -- for a selected node
 * or edge, over `?from=&to=` (default last 24h). Surfaced both in the map
 * inspector drawer and on the full service page.
 */
export async function errorRoutes(app: FastifyInstance): Promise<void> {
  // Errors a service is producing, by its handled operation.
  app.get('/services/:id/errors', async (req) => {
    const id = (req.params as { id: string }).id;
    const range = parseRange(req.query as Record<string, unknown>);
    const ids = aliases.expand(id);
    // External services emit no telemetry of their own; surface the errors
    // their callers recorded against them instead.
    const external = (await getLive().snapshot.current()).serviceById.get(aliases.canonical(id))?.isExternal ?? false;
    return external
      ? errorBreakdown({ ...range, kind: 'edge_error_rollup', filter: { target_id: ids } })
      : errorBreakdown({ ...range, kind: 'svc_error_rollup', filter: { service_id: ids } });
  });

  // Errors seen on one dependency edge, from the caller's client spans.
  app.get('/edges/:source/:target/errors', async (req) => {
    const { source, target } = req.params as { source: string; target: string };
    const range = parseRange(req.query as Record<string, unknown>);
    return errorBreakdown({
      ...range,
      kind: 'edge_error_rollup',
      filter: { source_id: aliases.expand(source), target_id: aliases.expand(target) },
    });
  });
}
