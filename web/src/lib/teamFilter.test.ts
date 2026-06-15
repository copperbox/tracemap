import { describe, expect, it } from 'vitest';
import { matchesTeamFilter, teamFilterLabel, teamOptions } from './teamFilter';

const TEAMS = [
  { id: 1, name: 'Aurora' },
  { id: 2, name: 'Boreal' },
  { id: 3, name: 'Cobalt' },
];

describe('matchesTeamFilter', () => {
  it("passes everything under 'all'", () => {
    expect(matchesTeamFilter(2, 'all')).toBe(true);
    expect(matchesTeamFilter(null, 'all')).toBe(true);
  });

  it("matches only unassigned services under 'none'", () => {
    expect(matchesTeamFilter(null, 'none')).toBe(true);
    expect(matchesTeamFilter(2, 'none')).toBe(false);
  });

  it('matches only the chosen team id under a numeric filter', () => {
    expect(matchesTeamFilter(2, 2)).toBe(true);
    expect(matchesTeamFilter(3, 2)).toBe(false);
    expect(matchesTeamFilter(null, 2)).toBe(false);
  });
});

describe('teamFilterLabel', () => {
  it('labels the special values', () => {
    expect(teamFilterLabel('all', TEAMS)).toBe('All teams');
    expect(teamFilterLabel('none', TEAMS)).toBe('Unassigned');
  });

  it('resolves a team id to its name, with a fallback', () => {
    expect(teamFilterLabel(2, TEAMS)).toBe('Boreal');
    expect(teamFilterLabel(99, TEAMS)).toBe('team 99');
  });
});

describe('teamOptions', () => {
  it('lists All teams + Unassigned ahead of the teams, with labels', () => {
    const opts = teamOptions(TEAMS);
    expect(opts.map((o) => o.value)).toEqual(['all', 'none', 1, 2, 3]);
    expect(opts.slice(0, 2).map((o) => o.label)).toEqual(['All teams', 'Unassigned']);
  });
});
