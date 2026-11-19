import type { ServiceList, TopologyService } from '../api/types';
import { filterRankServices, type RankableService } from '../lib/serviceRank';
import type { TeamFilterValue } from '../lib/teamFilter';

/**
 * Rows for the services table and the wallboard. Live numbers and status come
 * from the store topology (updated every frame); sparklines and SLO come from
 * GET /api/services on a slow refresh and are joined by service id.
 */

export interface ServiceRow extends RankableService {
  svc: TopologyService;
}

// One row object per service object, so a row is the same object for as long
// as the merge keeps its service (memoized row components skip re-render).
const rowCache = new WeakMap<TopologyService, ServiceRow>();

export function serviceRow(svc: TopologyService): ServiceRow {
  let row = rowCache.get(svc);
  if (!row) {
    row = { id: svc.id, name: svc.name, teamId: svc.teamId, status: svc.status, rps: svc.metrics.rps, svc };
    rowCache.set(svc, row);
  }
  return row;
}

export function rankServiceRows(
  services: TopologyService[],
  search: string,
  teamFilter: TeamFilterValue,
): ServiceRow[] {
  return filterRankServices(services.map(serviceRow), search, teamFilter);
}

export interface ServiceExtra {
  spark: number[];
  sloAttain: number | null;
}

const sameNumbers = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Index a /services response by id, keeping the previous entry (and its spark
 * array) when nothing in it changed, so a sparkline does not re-render on a
 * refresh that brought the same data.
 */
export function mergeExtras(
  prev: Map<string, ServiceExtra> | null,
  list: ServiceList,
): Map<string, ServiceExtra> {
  const next = new Map<string, ServiceExtra>();
  for (const s of list.services) {
    const old = prev?.get(s.id);
    if (old && old.sloAttain === s.sloAttain && sameNumbers(old.spark, s.spark)) {
      next.set(s.id, old);
    } else {
      const spark = old && sameNumbers(old.spark, s.spark) ? old.spark : s.spark;
      next.set(s.id, { spark, sloAttain: s.sloAttain });
    }
  }
  return next;
}
