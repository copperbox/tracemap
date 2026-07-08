import { useEffect } from 'react';
import { FooterButton } from '../map/drawer/FooterButton';
import { ServiceDetails } from '../map/drawer/ServiceDetails';
import { useStore } from '../../state/store';
import { relatedServiceId } from './wallboardSelection';
import styles from './WallboardDrawer.module.css';

/**
 * Wallboard counterpart of the map's node drawer: renders the same
 * ServiceDetails stack for the selected card. Dep-row clicks jump to the
 * related service's card (there is no edge to select here), and the footer
 * offers the two off-wallboard actions: the service page and the layered map
 * isolated to this service's dependency tree.
 */
export function WallboardDrawer() {
  const topology = useStore((s) => s.topology);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const navigate = useStore((s) => s.navigate);
  const isolateOnMap = useStore((s) => s.isolateOnMap);

  // Stale selection (service left the topology, or an edge/group selection
  // deep-linked over from the map): close gracefully.
  useEffect(() => {
    if (!selection || !topology) return;
    if (selection.kind !== 'node' || !topology.services.some((x) => x.id === selection.id)) select(null);
  }, [selection, topology, select]);

  const svc =
    selection?.kind === 'node' && topology
      ? topology.services.find((x) => x.id === selection.id)
      : undefined;

  return (
    <div className={`${styles.drawer} ${svc ? styles.open : ''}`}>
      {svc && topology && (
        <ServiceDetails
          service={svc}
          topology={topology}
          onClose={() => select(null)}
          onSelectEdge={(e) => select({ kind: 'node', id: relatedServiceId(e, svc.id) })}
          footer={
            <>
              <FooterButton primary onClick={() => navigate('service', svc.id)}>
                View full service
              </FooterButton>
              <FooterButton onClick={() => isolateOnMap(svc.id)}>View isolated tree</FooterButton>
            </>
          }
        />
      )}
    </div>
  );
}
