import type { Status } from '../api/types';

export function stColor(st: Status): string {
  return st === 'crit' ? 'var(--crit)' : st === 'warn' ? 'var(--warn)' : 'var(--ok)';
}

export function stBg(st: Status): string {
  return st === 'crit' ? 'var(--critbg)' : st === 'warn' ? 'var(--warnbg)' : 'var(--okbg)';
}

export function stLabel(st: Status): string {
  return st === 'crit' ? 'Critical' : st === 'warn' ? 'Degraded' : 'Healthy';
}

export function worst(statuses: Status[]): Status {
  if (statuses.includes('crit')) return 'crit';
  if (statuses.includes('warn')) return 'warn';
  return 'ok';
}

export interface SloView {
  pct: string;
  dash: string;
  color: string;
  budgetW: string;
  budgetTxt: string;
  targetTxt: string;
}

export function sloView(target: number, attain: number | null): SloView {
  const a = attain ?? 100;
  const budget = 100 - target;
  const left = Math.max(0, Math.min(1, 1 - (100 - a) / (budget || 0.1)));
  const C = 2 * Math.PI * 26;
  return {
    pct: a.toFixed(2),
    dash: `${(C * left).toFixed(1)} ${C.toFixed(1)}`,
    color: left > 0.5 ? 'var(--ok)' : left > 0.2 ? 'var(--warn)' : 'var(--crit)',
    budgetW: `${Math.round(left * 100)}%`,
    budgetTxt: `${Math.round(left * 100)}% error budget remaining`,
    targetTxt: `${target}%`,
  };
}
