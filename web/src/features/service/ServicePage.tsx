import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { ServiceDetail, TraceListItem } from '../../api/types';
import { BigChart } from '../../components/BigChart';
import { BackIcon, TYPE_LABELS } from '../../components/Icon';
import { SloRing } from '../../components/SloRing';
import { DOT, fmtErr, fmtMs, fmtRps, fmtAgo, jit } from '../../lib/format';
import { stBg, stColor, stLabel, sloView } from '../../lib/status';
import { isLiveRange, rangeLabel, resolveRange } from '../../lib/timerange';
import { useStore } from '../../state/store';
import { EditServiceModal } from './EditServiceModal';
import { TimeRangePicker } from './TimeRangePicker';

const mono = (px: number, weight = 500): string => `${weight} ${px}px 'JetBrains Mono', monospace`;
const LABEL: React.CSSProperties = { font: mono(9, 600), letterSpacing: '.14em', color: 'var(--faint)' };
const CARD: React.CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 12,
  padding: '14px 16px',
};

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
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ font: mono(11), color: 'var(--faint)' }}>{error ?? `loading ${serviceId}\u2026`}</span>
      </div>
    );
  }

  const s = detail.service;
  const k = detail.kpis;
  const slo = sloView(s.sloTarget, s.sloAttain);
  const c = stColor(s.status);
  const times = detail.series.map((p) => new Date(p.t));
  const latMax = Math.max(1e-9, ...detail.series.map((p) => p.p99 ?? p.p95 ?? 0));
  const errMax = Math.max(0.5, ...detail.series.map((p) => p.errPct ?? 0));
  const up = detail.neighbors.filter((n) => n.direction === 'upstream');
  const down = detail.neighbors.filter((n) => n.direction === 'downstream');
  const maxTraceDur = Math.max(1, ...traces.map((t) => t.durationMs));
  const { from, to } = resolveRange(range);
  const rangeStartLabel = isLiveRange(range) ? `-${rangeLabel(range).replace('Last ', '')}` : rangeLabel(range).split(' \u2192 ')[0];
  const rangeEndLabel = isLiveRange(range) ? 'now' : rangeLabel(range).split(' \u2192 ')[1];

  const kpis = [
    { label: 'THROUGHPUT', value: `${fmtRps(k.rps * jit(s.id, tick))}/s`, sub: 'avg over selected range', color: 'var(--text)' },
    {
      label: 'LATENCY P95',
      value: fmtMs(k.p95 == null ? null : k.p95 * jit(s.id + 'l', tick, 0.06)),
      sub: `p50 ${fmtMs(k.p50)} ${DOT} p99 ${fmtMs(k.p99)}`,
      color: s.status === 'ok' ? 'var(--text)' : c,
    },
    {
      label: 'ERROR RATE',
      value: fmtErr(k.errPct),
      sub: s.status === 'ok' ? 'within baseline' : 'above baseline',
      color: s.status === 'ok' ? 'var(--text)' : c,
    },
    {
      label: 'SLO ATTAINMENT',
      value: s.sloAttain == null ? '--' : `${s.sloAttain.toFixed(2)}%`,
      sub: `target ${s.sloTarget}% ${DOT} 30 days`,
      color: slo.color,
    },
  ];

  const neighborRow = (n: (typeof up)[number]) => {
    const otherName = n.otherId;
    return (
      <div
        key={`${n.source}->${n.target}`}
        className="hov-row"
        onClick={() => navigate('service', n.otherId)}
        style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 8px', borderRadius: 8, cursor: 'pointer' }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: stColor(n.status), flex: 'none' }} />
        <span style={{ font: "600 12px 'Space Grotesk'", flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {otherName}
        </span>
        {n.manual && (
          <span style={{ font: mono(8.5, 600), letterSpacing: '.08em', color: 'var(--accent)', border: '1px solid var(--accent-dim)', background: 'var(--accent-dim)', borderRadius: 4, padding: '1px 5px' }}>
            MANUAL
          </span>
        )}
        <span style={{ font: mono(10), color: 'var(--dim)' }}>{fmtRps(n.rps)}/s</span>
        <span style={{ font: mono(10), color: 'var(--dim)', width: 52, textAlign: 'right' }}>{fmtMs(n.p95)}</span>
      </div>
    );
  };

  return (
    <div style={{ position: 'absolute', inset: 0, overflowY: 'auto' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 32px 56px' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div
            className="hov-link"
            onClick={() => navigate('map')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              cursor: 'pointer',
              color: 'var(--dim)',
              font: "600 12px 'Space Grotesk'",
              padding: '5px 8px',
              borderRadius: 7,
              marginLeft: -8,
            }}
          >
            <BackIcon />
            Service map
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <TimeRangePicker value={range} onChange={setRange} />
            <div
              className="hov-btn"
              onClick={() => setEditOpen(true)}
              style={{
                padding: '7px 14px',
                borderRadius: 9,
                border: '1px solid var(--line2)',
                color: 'var(--dim)',
                font: "600 12px 'Space Grotesk'",
                cursor: 'pointer',
              }}
            >
              Edit service
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 18, margin: '14px 0 20px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
              <div style={{ font: "700 25px 'Space Grotesk'", letterSpacing: '.01em' }}>{s.name}</div>
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 11px',
                  borderRadius: 999,
                  background: stBg(s.status),
                  color: c,
                  font: mono(11, 600),
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
                {stLabel(s.status)}
              </div>
              <div style={{ padding: '4px 11px', borderRadius: 999, border: '1px solid var(--line)', color: 'var(--dim)', font: mono(11, 600) }}>
                {s.teamName ?? 'unassigned'}
              </div>
              <div style={{ padding: '4px 11px', borderRadius: 999, border: '1px solid var(--line)', color: 'var(--faint)', font: mono(10, 600), letterSpacing: '.1em' }}>
                {TYPE_LABELS[s.type] ?? s.type.toUpperCase()}
              </div>
            </div>
            <div style={{ font: mono(11), color: 'var(--faint)', marginTop: 8 }}>
              {[
                s.runtime,
                s.region,
                `${down.length} downstream ${DOT} ${up.length} upstream`,
                `last seen ${fmtAgo(s.lastSeen)} ago`,
              ]
                .filter(Boolean)
                .join(` ${DOT} `)}
            </div>
            {s.description && (
              <div style={{ font: "500 12.5px 'Space Grotesk'", color: 'var(--dim)', marginTop: 8, maxWidth: 720 }}>
                {s.description}
              </div>
            )}
          </div>
          <SloRing target={s.sloTarget} attain={s.sloAttain} size={74} caption="SLO 30D" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 12 }}>
          {kpis.map((kpi) => (
            <div key={kpi.label} style={CARD}>
              <div style={LABEL}>{kpi.label}</div>
              <div style={{ font: mono(21, 700), margin: '7px 0 4px', color: kpi.color }}>{kpi.value}</div>
              <div style={{ font: mono(10), color: 'var(--dim)' }}>{kpi.sub}</div>
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div style={CARD}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
              <div style={LABEL}>{`LATENCY ${DOT} ${rangeLabel(range).toUpperCase()}`}</div>
              <div style={{ flex: 1 }} />
              <div style={{ display: 'flex', gap: 10, font: mono(9), color: 'var(--dim)' }}>
                {(
                  [
                    ['var(--faint)', 'p50'],
                    ['var(--accent)', 'p95'],
                    ['var(--warn)', 'p99'],
                  ] as const
                ).map(([col, lab]) => (
                  <span key={lab} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 8, height: 2, background: col }} />
                    {lab}
                  </span>
                ))}
              </div>
            </div>
            <BigChart
              lines={[
                { label: 'p50', color: 'var(--faint)', values: detail.series.map((p) => p.p50), width: 1.3 },
                { label: 'p95', color: 'var(--accent)', values: detail.series.map((p) => p.p95), width: 1.7 },
                { label: 'p99', color: 'var(--warn)', values: detail.series.map((p) => p.p99), width: 1.3, opacity: 0.85 },
              ]}
              times={times}
              fmt={fmtMs}
              gridLines={4}
              max={latMax}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', font: mono(9), color: 'var(--faint)', marginTop: 6 }}>
              <span>{rangeStartLabel}</span>
              <span>{`${fmtMs(latMax)} peak`}</span>
              <span>{rangeEndLabel}</span>
            </div>
          </div>
          <div style={CARD}>
            <div style={{ ...LABEL, marginBottom: 10 }}>{`THROUGHPUT ${DOT} ${rangeLabel(range).toUpperCase()}`}</div>
            <BigChart
              lines={[{ label: 'req/s', color: 'var(--accent)', values: detail.series.map((p) => p.rps), width: 1.7 }]}
              area
              times={times}
              fmt={(v) => `${fmtRps(v)}/s`}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', font: mono(9), color: 'var(--faint)', marginTop: 6 }}>
              <span>{rangeStartLabel}</span>
              <span>{rangeEndLabel}</span>
            </div>
          </div>
          <div style={CARD}>
            <div style={{ ...LABEL, marginBottom: 10 }}>{`ERROR RATE ${DOT} ${rangeLabel(range).toUpperCase()}`}</div>
            <BigChart
              bars={{
                label: 'error rate',
                color: (v: number) => (v > 2 ? 'var(--crit)' : v > 0.8 ? 'var(--warn)' : 'var(--line2)'),
                values: detail.series.map((p) => p.errPct),
              }}
              times={times}
              fmt={(v) => `${v.toFixed(2)}%`}
              max={errMax}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', font: mono(9), color: 'var(--faint)', marginTop: 6 }}>
              <span>{rangeStartLabel}</span>
              <span>{rangeEndLabel}</span>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.45fr', gap: 12, marginBottom: 12 }}>
          <div style={CARD}>
            <div style={{ ...LABEL, marginBottom: 8 }}>{`CALLED BY ${DOT} ${up.length}`}</div>
            <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 12 }}>{up.map(neighborRow)}</div>
            <div style={{ ...LABEL, marginBottom: 8 }}>{`DEPENDS ON ${DOT} ${down.length}`}</div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>{down.map(neighborRow)}</div>
          </div>
          <div style={CARD}>
            <div style={{ ...LABEL, marginBottom: 4 }}>TOP OPERATIONS</div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1.7fr 70px 70px 70px 60px',
                gap: 10,
                padding: '8px 8px 9px',
                borderBottom: '1px solid var(--line)',
              }}
            >
              {['OPERATION', 'REQ/S', 'P95', 'P99', 'ERR'].map((h, i) => (
                <span key={h} style={{ font: mono(8.5, 600), letterSpacing: '.12em', color: 'var(--faint)', textAlign: i ? 'right' : 'left' }}>
                  {h}
                </span>
              ))}
            </div>
            {detail.operations.map((o) => (
              <div
                key={o.name}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.7fr 70px 70px 70px 60px',
                  gap: 10,
                  padding: '9px 8px',
                  borderBottom: '1px solid var(--line)',
                  alignItems: 'center',
                }}
              >
                <span style={{ font: mono(11, 600), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.name}</span>
                <span style={{ font: mono(10.5), color: 'var(--dim)', textAlign: 'right' }}>{fmtRps(o.rps)}</span>
                <span style={{ font: mono(10.5), color: 'var(--dim)', textAlign: 'right' }}>{fmtMs(o.p95)}</span>
                <span style={{ font: mono(10.5), color: 'var(--dim)', textAlign: 'right' }}>{fmtMs(o.p99)}</span>
                <span
                  style={{
                    font: mono(10.5, 600),
                    textAlign: 'right',
                    color: (o.errPct ?? 0) > 2 ? 'var(--crit)' : (o.errPct ?? 0) > 0.8 ? 'var(--warn)' : 'var(--dim)',
                  }}
                >
                  {o.errPct == null ? '--' : fmtErr(o.errPct)}
                </span>
              </div>
            ))}
            {!detail.operations.length && (
              <div style={{ padding: '18px 8px', font: mono(10.5), color: 'var(--faint)' }}>
                no operations observed in this range
              </div>
            )}
          </div>
        </div>

        <div style={CARD}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
            <div style={LABEL}>RECENT TRACES</div>
            <div style={{ flex: 1 }} />
            <div style={{ font: mono(9.5), color: 'var(--faint)' }}>{`within selected range ${DOT} click to inspect`}</div>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '14px 150px 1.6fr 220px 70px 80px',
              gap: 12,
              padding: '8px 8px 9px',
              borderBottom: '1px solid var(--line)',
            }}
          >
            <span />
            {['TRACE ID', 'ROOT OPERATION', 'DURATION', 'SPANS', 'AGE'].map((h, i) => (
              <span key={h} style={{ font: mono(8.5, 600), letterSpacing: '.12em', color: 'var(--faint)', textAlign: i >= 3 ? 'right' : 'left' }}>
                {h}
              </span>
            ))}
          </div>
          {traces.map((t) => (
            <div
              key={t.traceId}
              className="hov-row"
              onClick={() => openTrace(t.traceId)}
              style={{
                display: 'grid',
                gridTemplateColumns: '14px 150px 1.6fr 220px 70px 80px',
                gap: 12,
                padding: '10px 8px',
                borderBottom: '1px solid var(--line)',
                alignItems: 'center',
                cursor: 'pointer',
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: t.status === 'error' ? 'var(--crit)' : 'var(--ok)' }} />
              <span style={{ font: mono(10.5, 600), color: 'var(--accent)' }}>{t.traceId.slice(0, 16)}</span>
              <span style={{ font: mono(11.5, 600), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.rootOperation}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    height: 5,
                    borderRadius: 3,
                    background: 'var(--accent)',
                    opacity: 0.5,
                    width: Math.max(4, Math.round((t.durationMs / maxTraceDur) * 130)),
                  }}
                />
                <span style={{ font: mono(10.5, 600) }}>{fmtMs(t.durationMs)}</span>
              </span>
              <span style={{ font: mono(10.5), color: 'var(--dim)', textAlign: 'right' }}>{t.spanCount}</span>
              <span style={{ font: mono(10.5), color: 'var(--faint)', textAlign: 'right' }}>{fmtAgo(t.time)}</span>
            </div>
          ))}
          {!traces.length && (
            <div style={{ padding: '18px 8px', font: mono(10.5), color: 'var(--faint)' }}>no traces in this range</div>
          )}
        </div>
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
