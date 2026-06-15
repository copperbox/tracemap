import type { ComboOption } from './combobox';

/**
 * Shared team-filter vocabulary used by both the service map (which dims
 * non-matching nodes) and the services list (which hides non-matching rows).
 * Keeping the value type and the matching/labelling rules in one place means
 * the two views -- and the reusable <TeamFilter> dropdown -- can never drift.
 *
 * `'all'`  -> no filtering.
 * `'none'` -> only services with no owning team (teamId == null).
 * number   -> only services owned by that team id.
 */
export type TeamFilterValue = number | 'all' | 'none';

export interface TeamRef {
  id: number;
  name: string;
}

export type TeamOption = ComboOption<TeamFilterValue>;

/** Does a service with this (possibly null) team id pass the active filter? */
export function matchesTeamFilter(teamId: number | null, filter: TeamFilterValue): boolean {
  if (filter === 'all') return true;
  if (filter === 'none') return teamId == null;
  return teamId === filter;
}

/** Human label for the current selection (shown on the dropdown trigger). */
export function teamFilterLabel(value: TeamFilterValue, teams: TeamRef[]): string {
  if (value === 'all') return 'All teams';
  if (value === 'none') return 'Unassigned';
  return teams.find((t) => t.id === value)?.name ?? `team ${value}`;
}

/** The selectable options: "All teams", "Unassigned", then each team. The
 *  <Combobox> handles search-narrowing, so this returns the full ordered list. */
export function teamOptions(teams: TeamRef[]): TeamOption[] {
  return [
    { label: 'All teams', value: 'all' },
    { label: 'Unassigned', value: 'none' },
    ...teams.map((t) => ({ label: t.name, value: t.id })),
  ];
}
