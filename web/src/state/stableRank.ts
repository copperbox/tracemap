import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Status } from '../api/types';
import { compareRank } from '../lib/serviceRank';

/**
 * Stable order for the services table and wallboard. Ranking follows live
 * numbers that change every frame, so re-sorting on every frame shuffles rows
 * under the pointer. The full re-sort runs when the set of listed services
 * changes or every RERANK_MS. A service that changes status moves to its new
 * band at once, and only it moves: in a large fleet some status flips nearly
 * every frame. Nothing moves while the user is inside the list (pointer or
 * keyboard focus). The numbers in the rows stay live throughout.
 */

export const RERANK_MS = 15_000;

export interface RankState {
  ids: string[];
  /** status of each listed service when the order was last computed */
  status: Map<string, Status>;
  at: number;
}

interface Ranked {
  id: string;
  status: Status;
  rps: number;
}

/** `ranked` is the freshly ranked list; returns it, or the same rows in the kept order. */
export function stableRank<T extends Ranked>(
  prev: RankState | null,
  ranked: T[],
  now: number,
  held: boolean,
): { rows: T[]; state: RankState } {
  const fresh = () => ({
    rows: ranked,
    state: { ids: ranked.map((r) => r.id), status: new Map(ranked.map((r) => [r.id, r.status])), at: now },
  });
  if (!prev) return fresh();
  const byId = new Map(ranked.map((r) => [r.id, r]));
  const sameSet = prev.ids.length === ranked.length && prev.ids.every((id) => byId.has(id));
  if (!held && (!sameSet || now - prev.at >= RERANK_MS)) return fresh();
  if (!held) {
    const moved = ranked.filter((r) => prev.status.get(r.id) !== r.status);
    if (moved.length) return reinsert(prev, byId, moved);
  }
  // keep the order; while held, rows that left drop out and new ones go last
  const rows: T[] = [];
  for (const id of prev.ids) {
    const r = byId.get(id);
    if (r) rows.push(r);
  }
  if (sameSet) return { rows, state: prev };
  const kept = new Set(prev.ids);
  const status = new Map(prev.status);
  for (const r of ranked) {
    if (kept.has(r.id)) continue;
    rows.push(r);
    status.set(r.id, r.status);
  }
  return { rows, state: { ids: rows.map((r) => r.id), status, at: prev.at } };
}

/** The kept order with each service in `moved` taken out and put back where its new status ranks it. */
function reinsert<T extends Ranked>(prev: RankState, byId: Map<string, T>, moved: T[]): { rows: T[]; state: RankState } {
  const out = new Set(moved.map((r) => r.id));
  const rows: T[] = [];
  for (const id of prev.ids) {
    const r = byId.get(id);
    if (r && !out.has(id)) rows.push(r);
  }
  const status = new Map(prev.status);
  for (const m of [...moved].sort(compareRank)) {
    let i = 0;
    while (i < rows.length && compareRank(rows[i], m) <= 0) i++;
    rows.splice(i, 0, m);
    status.set(m.id, m.status);
  }
  return { rows, state: { ids: rows.map((r) => r.id), status, at: prev.at } };
}

/** True while the pointer or keyboard focus is inside `ref`'s element. */
export function useListHold(ref: RefObject<HTMLElement | null>): boolean {
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const enter = () => setPointer(true);
    const leave = () => setPointer(false);
    const focusIn = () => setFocus(true);
    const focusOut = (e: FocusEvent) => setFocus(el.contains(e.relatedTarget as Node | null));
    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('focusin', focusIn);
    el.addEventListener('focusout', focusOut);
    return () => {
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('focusin', focusIn);
      el.removeEventListener('focusout', focusOut);
    };
  }, [ref]);
  return pointer || focus;
}

/** `ranked` in a stable order (see stableRank). */
export function useStableRank<T extends Ranked>(ranked: T[], held: boolean): T[] {
  const stateRef = useRef<RankState | null>(null);
  return useMemo(() => {
    const { rows, state } = stableRank(stateRef.current, ranked, Date.now(), held);
    stateRef.current = state;
    return rows;
  }, [ranked, held]);
}
