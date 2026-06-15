import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { BackIcon } from '../../components/Icon';
import { isLiveRange, resolveRange } from '../../lib/timerange';
import { resourcePhase } from '../../state/resource';
import { useResource } from '../../state/useResource';
import { useStore } from '../../state/store';
import { KpiCards } from './sections/KpiCards';
import { NeighborsPanel } from './sections/NeighborsPanel';
import { OperationsTable } from './sections/OperationsTable';
import { ServiceErrorsPanel } from './sections/ServiceErrorsPanel';
import { ServiceHeader } from './sections/ServiceHeader';
import {
  ChartSkeleton,
  ErrorsSkeleton,
  HeaderSkeleton,
  KpiSkeleton,
  NeighborsSkeleton,
  OperationsSkeleton,
  TracesSkeleton,
} from './sections/Skeletons';
import { TracesPanel } from './sections/TracesPanel';
import styles from './ServicePage.module.css';
import { TimeRangePicker } from './TimeRangePicker';

// Heavy chunks (three SVG charts; the edit form) are split out so the page
// shell paints before their JS is parsed.
const ChartGrid = lazy(() => import('./sections/ChartGrid').then((m) => ({ default: m.ChartGrid })));
const EditServiceModal = lazy(() =>
  import('./EditServiceModal').then((m) => ({ default: m.EditServiceModal })),
);

export function ServicePage() {
  const serviceId = useStore((s) => s.serviceId);
  const navigate = useStore((s) => s.navigate);
  const range = useStore((s) => s.range);
  const setRange = useStore((s) => s.setRange);
  const openTrace = useStore((s) => s.openTrace);
  const tick = useStore((s) => s.tick);

  const [opFilter, setOpFilter] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const reload = () => setRefreshKey((k) => k + 1);
  const live = isLiveRange(range);
  const enabled = !!serviceId;

  // Drop the trace filter when switching services.
  useEffect(() => setOpFilter(null), [serviceId]);

  // Three independent resources so each section loads and reveals on its own
  // rather than the whole page blocking on one combined request.
  const detail = useResource(
    () => {
      const { from, to } = resolveRange(range);
      return api.serviceDetail(serviceId as string, from, to);
    },
    { deps: [serviceId, range, refreshKey], resetKey: serviceId, enabled, live },
  );

  const errors = useResource(
    () => {
      const { from, to } = resolveRange(range);
      return api.serviceErrors(serviceId as string, from, to);
    },
    { deps: [serviceId, range, refreshKey], resetKey: serviceId, enabled, live },
  );

  const traces = useResource(
    () => {
      const { from, to } = resolveRange(range);
      return api.serviceTraces(serviceId as string, from, to, opFilter ?? undefined);
    },
    { deps: [serviceId, range, refreshKey, opFilter], resetKey: serviceId, enabled, live },
  );

  if (!serviceId) return null;

  const d = detail.data;
  const detailFailed = resourcePhase(detail) === 'error';
  const up = d ? d.neighbors.filter((n) => n.direction === 'upstream') : [];
  const down = d ? d.neighbors.filter((n) => n.direction === 'downstream') : [];

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

        {detailFailed ? (
          <div className={styles.error}>
            <span className={styles.errorText}>{detail.error}</span>
            <button type="button" className={`${styles.retry} hov-btn`} onClick={reload}>
              retry
            </button>
          </div>
        ) : d ? (
          <>
            <ServiceHeader service={d.service} upCount={up.length} downCount={down.length} />
            <KpiCards detail={d} tick={tick} />
            <Suspense fallback={<ChartSkeleton />}>
              <ChartGrid series={d.series} range={range} />
            </Suspense>
            <div className={styles.lowerGrid}>
              <NeighborsPanel up={up} down={down} onOpenService={(id) => navigate('service', id)} />
              <OperationsTable operations={d.operations} />
            </div>
          </>
        ) : (
          <>
            <HeaderSkeleton />
            <KpiSkeleton />
            <ChartSkeleton />
            <div className={styles.lowerGrid}>
              <NeighborsSkeleton />
              <OperationsSkeleton />
            </div>
          </>
        )}

        {resourcePhase(errors) === 'loading' ? (
          <ErrorsSkeleton />
        ) : (
          <ServiceErrorsPanel
            ops={errors.data?.operations ?? []}
            activeOperation={opFilter}
            onSelectOperation={(op) => setOpFilter((prev) => (prev === op ? null : op))}
          />
        )}

        {resourcePhase(traces) === 'loading' ? (
          <TracesSkeleton />
        ) : (
          <TracesPanel
            traces={traces.data?.traces ?? []}
            onOpenTrace={openTrace}
            filterOp={opFilter}
            onClearFilter={() => setOpFilter(null)}
          />
        )}
      </div>

      {editOpen && d && (
        <Suspense fallback={null}>
          <EditServiceModal
            detail={d}
            onClose={() => setEditOpen(false)}
            onSaved={() => {
              setEditOpen(false);
              reload();
            }}
            onRefresh={reload}
          />
        </Suspense>
      )}
    </div>
  );
}
