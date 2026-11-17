import type { Topology } from '../api/types';
import { generateTopology, refreshMetrics } from './syntheticTopology';

/** How often the synthetic feed publishes a new metrics frame. */
export const SYNTHETIC_REFRESH_MS = 3000;

/**
 * Publish a synthetic topology of `n` nodes now, then fresh metrics every few
 * seconds to mimic the live feed. Returns a stop function. Dev builds only:
 * the caller guards the import with `import.meta.env.DEV`.
 */
export function startSyntheticFeed(n: number, publish: (t: Topology) => void): () => void {
  const t0 = performance.now();
  const { topology, baseline } = generateTopology(n);
  // eslint-disable-next-line no-console -- dev tool, the timing is the point
  console.info(
    `[synthetic] ${topology.services.length} services, ${topology.edges.length} edges, ` +
      `${topology.teams.length} teams in ${Math.round(performance.now() - t0)} ms`,
  );
  (window as unknown as { __syntheticReadyAt?: number }).__syntheticReadyAt = performance.now();
  let cur = topology;
  publish(cur);
  let step = 0;
  const i = setInterval(() => {
    cur = refreshMetrics(cur, baseline, ++step);
    publish(cur);
  }, SYNTHETIC_REFRESH_MS);
  return () => clearInterval(i);
}
