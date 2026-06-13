import type { ReactNode } from 'react';
import { CommunityGraphIcon, FlowGraphIcon } from '../../../components/Icon';
import type { GraphType } from '../../../state/store';
import styles from './GraphModeToggle.module.css';

/**
 * Segmented control (top-right of the canvas) for switching the map between
 * the layered dependency-flow view and the force-directed communities view.
 * Shifts left while the selection drawer is open, mirroring the zoom stack.
 */
export function GraphModeToggle({
  value,
  shifted,
  onChange,
}: {
  value: GraphType;
  /** True while the selection drawer is open. */
  shifted: boolean;
  onChange: (g: GraphType) => void;
}) {
  const options: { id: GraphType; label: string; icon: ReactNode }[] = [
    { id: 'map', label: 'Map', icon: <FlowGraphIcon /> },
    { id: 'communities', label: 'Communities', icon: <CommunityGraphIcon /> },
  ];
  return (
    <div className={`${styles.toggle} ${shifted ? styles.shifted : ''}`}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={`${styles.seg} ${value === o.id ? styles.active : ''}`}
          title={o.id === 'map' ? 'Layered dependency flow' : 'Force graph clustered by community'}
          onClick={(e) => {
            e.stopPropagation();
            onChange(o.id);
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}
