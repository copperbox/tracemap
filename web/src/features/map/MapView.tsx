import { useStore } from '../../state/store';
import { ForceGraph } from './force/ForceGraph';
import { LayeredMap } from './LayeredMap';

/**
 * The service map. Switches between the layered dependency-flow view and the
 * force-directed communities view; the toggle lives inside each view and both
 * share the app's selection/focus/search state.
 */
export function MapView() {
  const graphType = useStore((s) => s.graphType);
  return graphType === 'communities' ? <ForceGraph /> : <LayeredMap />;
}
