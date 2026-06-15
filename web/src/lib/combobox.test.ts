import { describe, expect, it } from 'vitest';
import { filterOptions, type ComboOption } from './combobox';

const OPTS: ComboOption<string | number>[] = [
  { label: 'All teams', value: 'all' },
  { label: 'Unassigned', value: 'none' },
  { label: 'Aurora', value: 1 },
  { label: 'Boreal', value: 2 },
];

describe('filterOptions', () => {
  it('returns everything for an empty or whitespace query', () => {
    expect(filterOptions(OPTS, '')).toHaveLength(4);
    expect(filterOptions(OPTS, '   ')).toHaveLength(4);
  });

  it('matches a case-insensitive label substring', () => {
    expect(filterOptions(OPTS, 'or').map((o) => o.label)).toEqual(['Aurora', 'Boreal']);
    expect(filterOptions(OPTS, 'AURORA').map((o) => o.label)).toEqual(['Aurora']);
  });

  it('can surface a single special option', () => {
    expect(filterOptions(OPTS, 'una').map((o) => o.value)).toEqual(['none']);
  });

  it('returns empty when nothing matches', () => {
    expect(filterOptions(OPTS, 'zzz')).toEqual([]);
  });
});
