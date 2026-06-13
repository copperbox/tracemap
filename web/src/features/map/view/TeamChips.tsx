import type { Team } from '../../../api/types';
import styles from './TeamChips.module.css';

/** Team filter + grouping chips floating over the top-left of the canvas. */
export function TeamChips({
  teams,
  teamFilter,
  allMerged,
  onToggleMergeAll,
  onFilter,
}: {
  teams: Team[];
  teamFilter: number | 'all';
  allMerged: boolean;
  onToggleMergeAll: () => void;
  onFilter: (id: number | 'all') => void;
}) {
  return (
    <div className={styles.bar}>
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
      {[{ id: 'all' as const, name: 'All teams' }, ...teams].map((t) => {
        const act = teamFilter === (t.id === 'all' ? 'all' : t.id);
        return (
          <div
            key={String(t.id)}
            className={`${styles.chip} ${act ? styles.chipActive : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onFilter(t.id === 'all' ? 'all' : (t.id as number));
            }}
          >
            {t.name}
          </div>
        );
      })}
    </div>
  );
}
