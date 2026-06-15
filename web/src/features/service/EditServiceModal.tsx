import { useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { ServiceDetail } from '../../api/types';
import { Combobox } from '../../components/Combobox';
import { CloseIcon } from '../../components/Icon';
import { ARROW, DOT } from '../../lib/format';
import { useStore } from '../../state/store';
import styles from './EditServiceModal.module.css';
import { Field } from './Field';

const TYPES = ['service', 'bff', 'gateway', 'postgres', 'redis', 'kafka', 'elastic', 's3', 'external'];

/**
 * Edit a service's identity (name, description, owning team/group, type, SLO),
 * manage manual dependency associations, and merge duplicate discovered
 * services into this one.
 */
export function EditServiceModal({
  detail,
  onClose,
  onSaved,
  onRefresh,
}: {
  detail: ServiceDetail;
  onClose: () => void;
  onSaved: () => void;
  /** Reload the service detail without closing the modal (after a merge/unmerge). */
  onRefresh: () => void;
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
  // Merge/unmerge get their own busy flag so they show progress in place and
  // refresh the modal instead of hijacking the footer Save button or closing.
  const [mergeBusy, setMergeBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const otherServices = useMemo(
    () => (topology?.services ?? []).filter((x) => x.id !== s.id).sort((a, b) => a.id.localeCompare(b.id)),
    [topology, s.id],
  );
  // Only team-less services are offered as merge sources -- assigned services
  // are deliberately owned and not treated as stray duplicates.
  const mergeOptions = useMemo(
    () => otherServices.filter((x) => x.teamId == null).map((x) => ({ label: x.id, value: x.id })),
    [otherServices],
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

  // Merge/unmerge keep the modal open and refresh in place so the merged-duplicate
  // list updates and the action can be reversed right away.
  const runMerge = async (fn: () => Promise<unknown>) => {
    setMergeBusy(true);
    setError(null);
    try {
      await fn();
      setMergeSource('');
      setConfirmMerge(false);
      onRefresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setMergeBusy(false);
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

  const mergeState = confirmMerge ? styles.confirm : mergeSource ? styles.ready : styles.idle;

  return (
    <div onClick={onClose} className={styles.overlay}>
      <div onClick={(e) => e.stopPropagation()} className={styles.modal}>
        <div className={styles.header}>
          <div>
            <div className={styles.label}>EDIT SERVICE</div>
            <div className={styles.serviceId}>{s.id}</div>
          </div>
          <div className={styles.spacer} />
          <div className={`${styles.closeBtn} hov-btn`} onClick={onClose}>
            <CloseIcon />
          </div>
        </div>

        <div className={styles.body}>
          <Field label="DISPLAY NAME">
            <input className={styles.input} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label="DESCRIPTION">
            <textarea
              className={`${styles.input} ${styles.textarea}`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this service do?"
            />
          </Field>
          <div className={styles.identityGrid}>
            <Field label="OWNING TEAM / GROUP">
              <input
                className={styles.input}
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
              <select className={styles.input} value={type} onChange={(e) => setType(e.target.value)}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="SLO TARGET %">
              <input className={styles.input} value={sloTarget} onChange={(e) => setSloTarget(e.target.value)} />
            </Field>
          </div>

          <div className={styles.divider} />

          <div>
            <div className={`${styles.label} ${styles.sectionLabel}`}>DEPENDENCIES</div>
            <div className={styles.depList}>
              {downstream.map((n) => (
                <div key={n.target} className={styles.depRow}>
                  <span className={styles.depName}>{n.otherId}</span>
                  <span className={`${styles.depKind} ${n.manual ? styles.manual : styles.learned}`}>
                    {n.manual ? 'MANUAL' : `LEARNED ${DOT} ${n.confidence.toFixed(1)}%`}
                  </span>
                  <span
                    className={`${styles.depRemove} hov-btn`}
                    title="Remove dependency"
                    onClick={() => run(() => api.removeDependency(s.id, n.otherId))}
                  >
                    <CloseIcon size={8} />
                  </span>
                </div>
              ))}
              {!downstream.length && <div className={styles.emptyNote}>none learned yet</div>}
            </div>
            <div className={styles.actionRow}>
              <select
                className={`${styles.input} ${styles.grow}`}
                value={newDep}
                onChange={(e) => setNewDep(e.target.value)}
              >
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
                className={`${styles.associateBtn} ${newDep ? styles.enabled : styles.disabled} hov-accent`}
                onClick={() => newDep && run(() => api.addDependency(s.id, newDep))}
              >
                Associate
              </div>
            </div>
            <div className={styles.note}>manual associations cover dependencies the trace inference cannot see</div>
          </div>

          <div className={styles.divider} />

          <div>
            <div className={`${styles.label} ${styles.sectionLabel}`}>MERGE DUPLICATE INTO THIS SERVICE</div>
            {detail.aliases.length > 0 && (
              <div className={styles.mergedList}>
                {detail.aliases.map((alias) => (
                  <div key={alias} className={styles.mergedRow}>
                    <span className={styles.mergedName}>{alias}</span>
                    <span className={styles.mergedTag}>MERGED</span>
                    <span
                      className={`${styles.unmergeBtn} ${mergeBusy ? styles.unmergeDisabled : ''} hov-btn`}
                      title="Split this duplicate back into its own service"
                      onClick={() => !mergeBusy && void runMerge(() => api.unmergeService(s.id, alias))}
                    >
                      Unmerge
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className={styles.actionRow}>
              <Combobox
                block
                dropUp
                options={mergeOptions}
                value={mergeSource}
                onChange={(v) => {
                  setMergeSource(v);
                  setConfirmMerge(false);
                }}
                label={mergeSource || 'pick the duplicate service'}
                placeholder="Filter services..."
                emptyText="no unassigned services"
                active={!!mergeSource}
              />
              <div
                className={`${styles.mergeBtn} ${mergeState} ${mergeBusy ? styles.busy : ''}`}
                onClick={() => {
                  if (!mergeSource || mergeBusy) return;
                  if (!confirmMerge) {
                    setConfirmMerge(true);
                    return;
                  }
                  void runMerge(() => api.mergeService(s.id, mergeSource));
                }}
              >
                {mergeBusy ? 'Merging...' : confirmMerge ? 'Confirm merge' : 'Merge'}
              </div>
            </div>
            <div className={styles.note}>
              {`re-points all telemetry from the duplicate here and aliases its name ${DOT} reversible via Unmerge`}
            </div>
          </div>

          {error && <div className={styles.errorBox}>{error}</div>}
        </div>

        <div className={styles.footer}>
          <div className={styles.spacer} />
          <div className={`${styles.cancelBtn} hov-btn`} onClick={onClose}>
            Cancel
          </div>
          <div
            className={`${styles.saveBtn} ${busy ? styles.busy : ''} hov-accent`}
            onClick={() => !busy && void save()}
          >
            {busy ? 'Saving\u2026' : 'Save changes'}
          </div>
        </div>
      </div>
    </div>
  );
}
