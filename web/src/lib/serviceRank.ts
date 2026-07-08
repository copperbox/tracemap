import type { Status } from '../api/types';
import { matchesTeamFilter, type TeamFilterValue } from './teamFilter';

/**
 * Shared "which services, in what order" rule for the list-style views: the
 * services table and the wallboard card grid both honor the global search box
 * and team filter, and both rank critical -> degraded -> healthy with the
 * busiest services first within each band. One implementation keeps the two
 * views from ever disagreeing about what an incident responder sees first.
 */
export interface RankableService {
  id: string;
  name: string;
  teamId: number | null;
  status: Status;
  rps: number;
}

const RANK: Record<Status, number> = { crit: 0, warn: 1, ok: 2 };

export function filterRankServices<T extends RankableService>(
  services: T[],
  search: string,
  teamFilter: TeamFilterValue,
): T[] {
  const q = search.trim().toLowerCase();
  return services
    .filter((s) => !q || s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
    .filter((s) => matchesTeamFilter(s.teamId, teamFilter))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || b.rps - a.rps);
}
