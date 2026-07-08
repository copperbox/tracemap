import type { TopologyEdge } from '../../api/types';
import type { Selection } from '../../state/store';

/** Card click: select that service's card, or clear when re-clicking the
 *  already-selected card (which closes the drawer). */
export function toggleCardSelection(current: Selection, id: string): Selection {
  return current?.kind === 'node' && current.id === id ? null : { kind: 'node', id };
}

/** The service on the other end of a CALLED BY / DEPENDS ON edge. The
 *  wallboard has no edges to select, so dep-row clicks jump to that card. */
export function relatedServiceId(edge: TopologyEdge, selfId: string): string {
  return edge.source === selfId ? edge.target : edge.source;
}
