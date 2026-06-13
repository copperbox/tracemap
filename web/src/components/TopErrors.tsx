import type { OperationErrors } from '../api/types';
import { DOT, fmtCount } from '../lib/format';
import styles from './TopErrors.module.css';

/**
 * Top erroring operations for a node or edge, each broken down into the
 * distinct errors seen and how often. Renders nothing when error-free.
 *
 * When `onSelectOperation` is supplied, operation headers become clickable
 * (used on the service page to filter the recent-traces list); `activeOperation`
 * marks the currently selected one.
 */
export function TopErrors({
  ops,
  onSelectOperation,
  activeOperation,
}: {
  ops: OperationErrors[];
  onSelectOperation?: (operation: string) => void;
  activeOperation?: string | null;
}) {
  if (!ops.length) return null;
  const clickable = !!onSelectOperation;
  return (
    <div>
      <div className={styles.label}>TOP ERRORING OPERATIONS</div>
      <div className={styles.list}>
        {ops.map((op) => {
          const active = activeOperation === op.operation;
          return (
            <div key={op.operation} className={styles.op}>
              <div
                className={`${styles.opHead} ${clickable ? `${styles.clickable} hov-row` : ''} ${active ? styles.active : ''}`}
                onClick={clickable ? () => onSelectOperation(op.operation) : undefined}
                title={clickable ? 'Filter recent traces to this operation' : undefined}
              >
                <span className={styles.opName}>{op.operation}</span>
                <span className={styles.opCount}>
                  {fmtCount(op.errorCount)} {op.errorCount === 1 ? 'err' : 'errs'}
                </span>
              </div>
              {op.errors.map((e, i) => (
                <div key={`${e.code}-${i}`} className={styles.err}>
                  <span className={styles.code}>{e.code}</span>
                  {e.message && <span className={styles.msg}>{e.message}</span>}
                  <span className={styles.count}>
                    {DOT} {fmtCount(e.count)}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
