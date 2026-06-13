import { TopBar } from './components/TopBar';
import { MapView } from './features/map/MapView';
import { ServicesPage } from './features/services/ServicesPage';
import { ServicePage } from './features/service/ServicePage';
import { TraceModal } from './features/trace/TraceModal';
import { useLiveData } from './state/usePolling';
import { useStore } from './state/store';
import styles from './App.module.css';

export function App() {
  useLiveData();
  const view = useStore((s) => s.view);
  const openTraceId = useStore((s) => s.openTraceId);

  return (
    <div className={styles.root}>
      <TopBar />
      <div className={styles.main}>
        {view === 'map' && <MapView />}
        {view === 'services' && <ServicesPage />}
        {view === 'service' && <ServicePage />}
        {openTraceId && <TraceModal traceId={openTraceId} />}
      </div>
    </div>
  );
}
