import { describe, expect, it } from 'vitest';
import { filterRankServices } from './serviceRank';

const svc = (
  id: string,
  status: 'ok' | 'warn' | 'crit',
  rps: number,
  teamId: number | null = 1,
  name = id.toUpperCase(),
) => ({ id, name, teamId, status, rps });

const FLEET = [
  svc('checkout', 'ok', 120),
  svc('payments', 'crit', 40),
  svc('search', 'warn', 300, 2),
  svc('emailer', 'warn', 5, null),
  svc('catalog', 'ok', 900, 2),
  svc('ledger', 'crit', 800),
];

describe('filterRankServices', () => {
  it('sorts critical -> degraded -> healthy, then by req/s descending', () => {
    expect(filterRankServices(FLEET, '', 'all').map((s) => s.id)).toEqual([
      'ledger',
      'payments',
      'search',
      'emailer',
      'catalog',
      'checkout',
    ]);
  });

  it('matches search against id and name, case-insensitively', () => {
    expect(filterRankServices(FLEET, 'LEDG', 'all').map((s) => s.id)).toEqual(['ledger']);
    expect(filterRankServices(FLEET, 'catalog', 'all').map((s) => s.id)).toEqual(['catalog']);
  });

  it('ignores surrounding whitespace in the search box', () => {
    expect(filterRankServices(FLEET, '  ledger  ', 'all').map((s) => s.id)).toEqual(['ledger']);
  });

  it('applies the team filter, including unassigned', () => {
    expect(filterRankServices(FLEET, '', 2).map((s) => s.id)).toEqual(['search', 'catalog']);
    expect(filterRankServices(FLEET, '', 'none').map((s) => s.id)).toEqual(['emailer']);
  });

  it('combines search and team filter', () => {
    expect(filterRankServices(FLEET, 'ca', 2).map((s) => s.id)).toEqual(['catalog']);
    expect(filterRankServices(FLEET, 'ledger', 2)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [...FLEET];
    filterRankServices(input, '', 'all');
    expect(input).toEqual(FLEET);
  });
});
