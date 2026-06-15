import { teamFilterLabel, teamOptions, type TeamFilterValue, type TeamRef } from '../lib/teamFilter';
import { Combobox } from './Combobox';

const TEAM_ICON = (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
    <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.2" />
    <path d="M1 10.5c0-1.7 1.3-3 3-3s3 1.3 3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <path d="M8.5 4.5 11 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

/**
 * Team picker shared by the service map and the services list: a thin team-aware
 * adapter over the generic <Combobox>. Offers "All teams", "Unassigned", then
 * every team, searchable by name.
 */
export function TeamFilter({
  teams,
  value,
  onChange,
}: {
  teams: TeamRef[];
  value: TeamFilterValue;
  onChange: (v: TeamFilterValue) => void;
}) {
  return (
    <Combobox
      options={teamOptions(teams)}
      value={value}
      onChange={onChange}
      label={teamFilterLabel(value, teams)}
      placeholder="Filter teams..."
      emptyText="no teams match"
      active={value !== 'all'}
      icon={TEAM_ICON}
    />
  );
}
