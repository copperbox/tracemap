import type { FastifyInstance } from 'fastify';
import { getLive } from '../live/index.js';
import { aliases } from './aliases.js';
import { readSeries } from './history.js';
import { sig4 } from './metrics.js';

const HOUR = 3_600_000;

/** Lightweight hourly series for the inspector drawer sparklines, from the rollup tiers. */
export async function seriesRoutes(app: FastifyInstance): Promise<void> {
  // 24 hourly points of a service's p95 / throughput / error rate.
  app.get('/services/:id/sparklines', async (req) => {
    const id = (req.params as { id: string }).id;
    const { reader, snapshot } = getLive();
    const now = Date.now();
    const ids = aliases.expand(id);
    const range = { fromMs: now - 24 * HOUR, toMs: now, bucketMs: HOUR };
    const external = (await snapshot.current()).serviceById.get(aliases.canonical(id))?.isExternal ?? false;
    let res = external ? null : await readSeries(reader, { ...range, kind: 'svc_rollup', filter: { service_id: ids } }, aliases.canonical);
    if (!res?.total) {
      // External service (or no own telemetry): series from what callers observe.
      res = await readSeries(reader, { ...range, kind: 'edge_rollup', filter: { target_id: ids } }, aliases.canonical);
    }
    return { points: res.points.map(({ t, rps, errPct, p95 }) => ({ t, rps, errPct, p95 })) };
  });

  // 24 hourly points of an edge's latency / call volume + operation mix.
  app.get('/edges/:source/:target/series', async (req) => {
    const { source, target } = req.params as { source: string; target: string };
    const { reader } = getLive();
    const now = Date.now();
    const filter = { source_id: aliases.expand(source), target_id: aliases.expand(target) };
    const range = { fromMs: now - 24 * HOUR, toMs: now, bucketMs: HOUR };
    const [series, ops] = await Promise.all([
      readSeries(reader, { ...range, kind: 'edge_rollup', filter }, aliases.canonical),
      reader.totals({ ...range, kind: 'edge_op_rollup', filter, groupBy: ['operation'] }, aliases.canonical),
    ]);
    ops.sort((a, b) => b.n - a.n);
    const top = ops.slice(0, 6);
    const total = top.reduce((a, r) => a + r.n, 0) || 1;
    return {
      points: series.points.map(({ t, rps, errPct, p95 }) => ({ t, rps, errPct, p95 })),
      operations: top.map((r) => ({ name: r.keys[0], share: sig4(r.n / total) })),
    };
  });
}
