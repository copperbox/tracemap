import type { Topology, TopologyEdge, TopologyService } from '../../../api/types';
import { DOT } from '../../../lib/format';

/**
 * The raw topology edges touching a service: inbound callers (CALLED BY)
 * and outbound dependencies (DEPENDS ON).
 */
export function serviceRelations(
  topology: Topology,
  serviceId: string,
): { callers: TopologyEdge[]; dependencies: TopologyEdge[] } {
  return {
    callers: topology.edges.filter((e) => e.target === serviceId),
    dependencies: topology.edges.filter((e) => e.source === serviceId),
  };
}

/** Header meta line: runtime / region / traffic liveness, dot-separated. */
export function serviceMeta(s: TopologyService): string {
  return [s.runtime, s.region, s.metrics.stale ? 'no recent traffic' : 'live']
    .filter(Boolean)
    .join(` ${DOT} `);
}
