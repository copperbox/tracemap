import type { Status, TopologyService } from '../api/types';

/** One row in a header health-count popover (HIGH-2). */
export interface UnhealthyService {
  id: string;
  name: string;
  status: Status;
  errPct: number;
  p95: number | null;
  rps: number;
}

/**
 * The services sitting in a given health status, worst-first. Sorted by error
 * rate, then tail latency, then name -- so the top of a "critical" or
 * "degraded" list is the most likely incident culprit. Backs the clickable
 * header health counts: a responder clicks the count and lands on the offending
 * services instead of hunting for red dots on the map.
 */
export function servicesByStatus(services: TopologyService[], status: Status): UnhealthyService[] {
  return services
    .filter((s) => s.status === status)
    .map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      errPct: s.metrics.errPct,
      p95: s.metrics.p95,
      rps: s.metrics.rps,
    }))
    .sort(
      (a, b) =>
        b.errPct - a.errPct || (b.p95 ?? 0) - (a.p95 ?? 0) || a.name.localeCompare(b.name),
    );
}
