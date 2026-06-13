import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { TraceDetail } from '../../api/types';
import { CloseIcon } from '../../components/Icon';
import { DOT, fmtAgo, fmtMs } from '../../lib/format';
import { svcColor } from '../../lib/spanPalette';
import { useStore } from '../../state/store';
import { buildRows } from './buildRows';
import { SpanRow } from './SpanRow';
import styles from './TraceModal.module.css';

export function TraceModal({ traceId }: { traceId: string }) {
  const openTrace = useStore((s) => s.openTrace);
  const theme = useStore((s) => s.theme);
  const [trace, setTrace] = useState<TraceDetail | null>(null);
  const [openSpan, setOpenSpan] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setTrace(null);
    setOpenSpan(null);
    api
      .trace(traceId)
      .then((t) => alive && setTrace(t))
      .catch((err) => alive && setError((err as Error).message));
    return () => {
      alive = false;
    };
  }, [traceId]);

  const built = useMemo(() => (trace ? buildRows(trace.spans) : null), [trace]);
  const close = () => openTrace(null);

  const hasError = trace?.spans.some((s) => s.isError) ?? false;
  const services = new Set(trace?.spans.map((s) => s.serviceId) ?? []);
  const firstStart = trace?.spans.length ? trace.spans[0].startTime : null;

  return (
    <div onClick={close} className={styles.overlay}>
      <div onClick={(e) => e.stopPropagation()} className={styles.modal}>
        <div className={styles.header}>
          <div className={styles.headerInfo}>
            <div className={styles.label}>TRACE</div>
            <div className={styles.idRow}>
              <span className={styles.traceId}>{traceId.slice(0, 16)}</span>
              <span className={`${styles.statusPill} ${hasError ? styles.error : styles.ok}`}>
                <span className={styles.statusDot} />
                {hasError ? 'ERROR' : 'OK'}
              </span>
            </div>
          </div>
          <div className={styles.spacer} />
          <div className={styles.summary}>
            {built
              ? `${fmtMs(built.totalMs)} total ${DOT} ${trace?.spans.length} spans ${DOT} ${services.size} services ${DOT} ${firstStart ? fmtAgo(firstStart) : '--'} ago`
              : error ?? 'loading\u2026'}
          </div>
          <div className={`${styles.closeBtn} hov-btn`} onClick={close}>
            <CloseIcon />
          </div>
        </div>

        <div className={styles.scaleRow}>
          <div className={styles.scaleLabel}>{`SPAN ${DOT} SERVICE`}</div>
          <div className={styles.scaleTrack}>
            {built &&
              Array.from({ length: 5 }, (_, i) => (
                <div key={i} className={styles.tick} style={{ left: `${i * 20}%` }}>
                  <div className={styles.tickLabel}>{fmtMs((built.totalMs * i) / 5)}</div>
                </div>
              ))}
          </div>
        </div>

        <div className={styles.body}>
          {built?.rows.map((r, i) => (
            <SpanRow
              key={r.span.spanId}
              row={r}
              totalMs={built.totalMs}
              color={r.span.isError ? 'var(--crit)' : svcColor(r.span.serviceId, theme)}
              isOpen={openSpan === i}
              onToggle={() => setOpenSpan(openSpan === i ? null : i)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
