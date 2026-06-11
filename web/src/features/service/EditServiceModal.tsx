import { useMemo, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import type { ServiceDetail } from '../../api/types';
import { CloseIcon } from '../../components/Icon';
import { ARROW, DOT } from '../../lib/format';
import { useStore } from '../../state/store';

const mono = (px: number, weight = 500): string => `${weight} ${px}px 'JetBrains Mono', monospace`;
const LABEL: React.CSSProperties = { font: mono(9, 600), letterSpacing: '.16em', color: 'var(--faint)' };
const INPUT: React.CSSProperties = {
  background: 'var(--panel2)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  color: 'var(--text)',
  font: mono(12),
  padding: '8px 10px',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

const TYPES = ['service', 'bff', 'gateway', 'postgres', 'redis', 'kafka', 'elastic', 's3', 'external'];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={LABEL}>{label}</span>
      {children}
    </label>
  );
}

/**
 * Edit a service's identity (name, description, owning team/group, type, SLO),
 * manage manual dependency associations, and merge duplicate discovered
 * services into this one.
 */
export function EditServiceModal({
  detail,
  onClose,
  onSaved,
}: {
  detail: ServiceDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const topology = useStore((s) => s.topology);
  const s = detail.service;

  const [displayName, setDisplayName] = useState(s.name);
  const [description, setDescription] = useState(s.description ?? '');
  const [team, setTeam] = useState(s.teamName ?? '');
  const [type, setType] = useState(s.type);
  const [sloTarget, setSloTarget] = useState(String(s.sloTarget));
  const [newDep, setNewDep] = useState('');
  const [mergeSource, setMergeSource] = useState('');
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const otherServices = useMemo(
    () => (topology?.services ?? []).filter((x) => x.id !== s.id).sort((a, b) => a.id.localeCompare(b.id)),
    [topology, s.id],
  );
  const teamNames = useMemo(
    () => [...new Set((topology?.teams ?? []).map((t) => t.name))].sort(),
    [topology],
  );
  const downstream = detail.neighbors.filter((n) => n.direction === 'downstream');

  const run = async (fn: () => Promise<unknown>, refresh = true) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (refresh) onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      await api.updateService(s.id, {
        displayName: displayName.trim() === s.id ? null : displayName.trim() || null,
        description: description.trim() || null,
        ...(team.trim() ? { teamName: team.trim() } : { teamId: null }),
        type,
        sloTarget: Number(sloTarget) || s.sloTarget,
      });
    });

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(3,6,12,.62)',
        backdropFilter: 'blur(7px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, 94%)',
          maxHeight: '86%',
          background: 'var(--bg2)',
          border: '1px solid var(--line2)',
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: 'var(--shadow)',
          animation: 'fadeUp .25s ease',
        }}
      >
        <div style={{ padding: '15px 20px 13px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 14 }}>
          <div>
            <div style={LABEL}>EDIT SERVICE</div>
            <div style={{ font: mono(14, 700), color: 'var(--accent)', marginTop: 3 }}>{s.id}</div>
          </div>
          <div style={{ flex: 1 }} />
          <div
            className="hov-btn"
            onClick={onClose}
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--faint)',
              border: '1px solid var(--line)',
            }}
          >
            <CloseIcon />
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="DISPLAY NAME">
            <input style={INPUT} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label="DESCRIPTION">
            <textarea
              style={{ ...INPUT, resize: 'vertical', minHeight: 56, fontFamily: "'Space Grotesk', sans-serif", fontSize: 12.5 }}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this service do?"
            />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 110px', gap: 10 }}>
            <Field label="OWNING TEAM / GROUP">
              <input
                style={INPUT}
                value={team}
                onChange={(e) => setTeam(e.target.value)}
                list="dt-teams"
                placeholder="unassigned"
              />
              <datalist id="dt-teams">
                {teamNames.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </Field>
            <Field label="TYPE">
              <select style={INPUT} value={type} onChange={(e) => setType(e.target.value)}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="SLO TARGET %">
              <input style={INPUT} value={sloTarget} onChange={(e) => setSloTarget(e.target.value)} />
            </Field>
          </div>

          <div style={{ height: 1, background: 'var(--line)' }} />

          <div>
            <div style={{ ...LABEL, marginBottom: 8 }}>DEPENDENCIES</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 10 }}>
              {downstream.map((n) => (
                <div key={n.target} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 4px' }}>
                  <span style={{ font: mono(11.5, 600), flex: 1 }}>{n.otherId}</span>
                  <span style={{ font: mono(9, 600), letterSpacing: '.08em', color: n.manual ? 'var(--accent)' : 'var(--faint)' }}>
                    {n.manual ? 'MANUAL' : `LEARNED ${DOT} ${n.confidence.toFixed(1)}%`}
                  </span>
                  <span
                    className="hov-btn"
                    title="Remove dependency"
                    onClick={() => run(() => api.removeDependency(s.id, n.otherId))}
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 5,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      color: 'var(--faint)',
                    }}
                  >
                    <CloseIcon size={8} />
                  </span>
                </div>
              ))}
              {!downstream.length && <div style={{ font: mono(10.5), color: 'var(--faint)' }}>none learned yet</div>}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <select style={{ ...INPUT, flex: 1 }} value={newDep} onChange={(e) => setNewDep(e.target.value)}>
                <option value="">{`add dependency ${ARROW} pick a service`}</option>
                {otherServices
                  .filter((o) => !downstream.some((d) => d.otherId === o.id))
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.id}
                    </option>
                  ))}
              </select>
              <div
                className="hov-accent"
                onClick={() => newDep && run(() => api.addDependency(s.id, newDep))}
                style={{
                  background: newDep ? 'var(--accent)' : 'var(--panel2)',
                  color: newDep ? 'var(--accent-ink)' : 'var(--faint)',
                  borderRadius: 8,
                  padding: '8px 16px',
                  font: "600 12px 'Space Grotesk'",
                  cursor: newDep ? 'pointer' : 'default',
                  alignSelf: 'stretch',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                Associate
              </div>
            </div>
            <div style={{ font: mono(9.5), color: 'var(--faint)', marginTop: 7 }}>
              manual associations cover dependencies the trace inference cannot see
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--line)' }} />

          <div>
            <div style={{ ...LABEL, marginBottom: 8 }}>MERGE DUPLICATE INTO THIS SERVICE</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                style={{ ...INPUT, flex: 1 }}
                value={mergeSource}
                onChange={(e) => {
                  setMergeSource(e.target.value);
                  setConfirmMerge(false);
                }}
              >
                <option value="">pick the duplicate service</option>
                {otherServices.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.id}
                  </option>
                ))}
              </select>
              <div
                onClick={() => {
                  if (!mergeSource || busy) return;
                  if (!confirmMerge) {
                    setConfirmMerge(true);
                    return;
                  }
                  void run(() => api.mergeService(s.id, mergeSource));
                }}
                style={{
                  background: confirmMerge ? 'var(--crit)' : mergeSource ? 'var(--accent)' : 'var(--panel2)',
                  color: mergeSource ? (confirmMerge ? '#fff' : 'var(--accent-ink)') : 'var(--faint)',
                  borderRadius: 8,
                  padding: '8px 16px',
                  font: "600 12px 'Space Grotesk'",
                  cursor: mergeSource ? 'pointer' : 'default',
                  display: 'flex',
                  alignItems: 'center',
                  whiteSpace: 'nowrap',
                }}
              >
                {confirmMerge ? 'Confirm merge' : 'Merge'}
              </div>
            </div>
            <div style={{ font: mono(9.5), color: 'var(--faint)', marginTop: 7 }}>
              {`re-points all telemetry from the duplicate here and aliases its name ${DOT} cannot be undone`}
            </div>
          </div>

          {error && (
            <div style={{ font: mono(10.5), color: 'var(--crit)', background: 'var(--critbg)', borderRadius: 8, padding: '8px 10px' }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ padding: '13px 20px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }} />
          <div
            className="hov-btn"
            onClick={onClose}
            style={{
              border: '1px solid var(--line2)',
              color: 'var(--dim)',
              borderRadius: 9,
              padding: '9px 18px',
              font: "600 12.5px 'Space Grotesk'",
              cursor: 'pointer',
            }}
          >
            Cancel
          </div>
          <div
            className="hov-accent"
            onClick={() => !busy && void save()}
            style={{
              background: 'var(--accent)',
              color: 'var(--accent-ink)',
              borderRadius: 9,
              padding: '9px 18px',
              font: "600 12.5px 'Space Grotesk'",
              cursor: 'pointer',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? 'Saving\u2026' : 'Save changes'}
          </div>
        </div>
      </div>
    </div>
  );
}
