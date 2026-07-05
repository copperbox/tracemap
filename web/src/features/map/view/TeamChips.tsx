import { TeamFilter } from '../../../components/TeamFilter';
import type { Team } from '../../../api/types';
import type { TeamFilterValue } from '../../../lib/teamFilter';
import styles from './TeamChips.module.css';

/** Team grouping shortcut + the shared searchable team filter, floating over
 *  the top-left of the canvas. */
export function TeamChips({
  teams,
  teamFilter,
  allMerged,
  showMerge = true,
  onToggleMergeAll,
  onFilter,
}: {
  teams: Team[];
  teamFilter: TeamFilterValue;
  allMerged: boolean;
  /** Hidden when team grouping is off, where merging has no meaning. */
  showMerge?: boolean;
  onToggleMergeAll: () => void;
  onFilter: (id: TeamFilterValue) => void;
}) {
  return (
    <div className={styles.bar}>
      {showMerge && (
        <>
          <div
            className={`${styles.chip} ${allMerged ? styles.chipActive : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleMergeAll();
            }}
          >
            {allMerged ? 'Unmerge all teams' : 'Merge all teams'}
          </div>
          <div className={styles.divider} />
        </>
      )}
      <TeamFilter teams={teams} value={teamFilter} onChange={onFilter} />
    </div>
  );
}
