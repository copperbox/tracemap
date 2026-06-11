import { TopBar } from './components/TopBar';
import { MapView } from './features/map/MapView';
import { ServicesPage } from './features/services/ServicesPage';
import { ServicePage } from './features/service/ServicePage';
import { TraceModal } from './features/trace/TraceModal';
import { useLiveData } from './state/usePolling';
import { useStore } from './state/store';

export function App() {
  useLiveData();
  const view = useStore((s) => s.view);
  const openTraceId = useStore((s) => s.openTraceId);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--bg)',
        color: 'var(--text)',
        fontFamily: "'Space Grotesk', system-ui, sans-serif",
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <TopBar />
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {view === 'map' && <MapView />}
        {view === 'services' && <ServicesPage />}
        {view === 'service' && <ServicePage />}
        {openTraceId && <TraceModal traceId={openTraceId} />}
      </div>
    </div>
  );
}
