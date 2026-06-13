import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { ServiceDetail, TraceListItem } from '../../api/types';
import { BackIcon } from '../../components/Icon';
import { isLiveRange, resolveRange } from '../../lib/timerange';
import { useStore } from '../../state/store';
import { EditServiceModal } from './EditServiceModal';
import { ChartGrid } from './sections/ChartGrid';
import { KpiCards } from './sections/KpiCards';
import { NeighborsPanel } from './sections/NeighborsPanel';
import { OperationsTable } from './sections/OperationsTable';
import { ServiceHeader } from './sections/ServiceHeader';
import { TracesPanel } from './sections/TracesPanel';
import styles from './ServicePage.module.css';
import { TimeRangePicker } from './TimeRangePicker';

export function ServicePage() {
  const serviceId = useStore((s) => s.serviceId);
  const navigate = useStore((s) => s.navigate);
  const range = useStore((s) => s.range);
  const setRange = useStore((s) => s.setRange);
  const openTrace = useStore((s) => s.openTrace);
  const tick = useStore((s) => s.tick);

  const [detail, setDetail] = useState<ServiceDetail | null>(null);
  const [traces, setTraces] = useState<TraceListItem[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!serviceId) return;
    let alive = true;
    const load = async () => {
      const { from, to } = resolveRange(range);
      try {
        const [d, t] = await Promise.all([
          api.serviceDetail(serviceId, from, to),
          api.serviceTraces(serviceId, from, to),
        ]);
        if (!alive) return;
        setDetail(d);
        setTraces(t.traces);
        setError(null);
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    };
    void load();
    const i = isLiveRange(range) ? setInterval(load, 30_000) : undefined;
    return () => {
      alive = false;
      if (i) clearInterval(i);
    };
  }, [serviceId, range, refreshKey]);

  if (!serviceId) return null;
  if (!detail) {
    return (
      <div className={styles.loading}>
        <span className={styles.loadingText}>{error ?? `loading ${serviceId}\u2026`}</span>
      </div>
    );
  }

  const up = detail.neighbors.filter((n) => n.direction === 'upstream');
  const down = detail.neighbors.filter((n) => n.direction === 'downstream');

  return (
    <div className={styles.page}>
      <div className={styles.content}>
        <div className={styles.toolbar}>
          <div className={`${styles.back} hov-link`} onClick={() => navigate('map')}>
            <BackIcon />
            Service map
          </div>
          <div className={styles.spacer} />
          <div className={styles.actions}>
            <TimeRangePicker value={range} onChange={setRange} />
            <div className={`${styles.editBtn} hov-btn`} onClick={() => setEditOpen(true)}>
              Edit service
            </div>
          </div>
        </div>

        <ServiceHeader service={detail.service} upCount={up.length} downCount={down.length} />
        <KpiCards detail={detail} tick={tick} />
        <ChartGrid series={detail.series} range={range} />

        <div className={styles.lowerGrid}>
          <NeighborsPanel up={up} down={down} onOpenService={(id) => navigate('service', id)} />
          <OperationsTable operations={detail.operations} />
        </div>

        <TracesPanel traces={traces} onOpenTrace={openTrace} />
      </div>

      {editOpen && detail && (
        <EditServiceModal
          detail={detail}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            reload();
          }}
        />
      )}
    </div>
  );
}
