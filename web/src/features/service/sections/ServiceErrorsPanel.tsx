import type { OperationErrors } from '../../../api/types';
import { TopErrors } from '../../../components/TopErrors';
import styles from './ServiceErrorsPanel.module.css';

/**
 * Service-page card listing the top erroring operations. Clicking an operation
 * filters the recent-traces panel to that operation's failures; clicking the
 * active one again clears the filter.
 */
export function ServiceErrorsPanel({
  ops,
  activeOperation,
  onSelectOperation,
}: {
  ops: OperationErrors[];
  activeOperation: string | null;
  onSelectOperation: (operation: string) => void;
}) {
  if (!ops.length) return null;
  return (
    <div className={styles.card}>
      <TopErrors ops={ops} activeOperation={activeOperation} onSelectOperation={onSelectOperation} />
    </div>
  );
}
