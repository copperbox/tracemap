import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../db/pool.js', () => ({ query: queryMock }));

import { ServiceRegistry } from './registry.js';

interface LoadRow {
  id: string;
  is_external: boolean;
  team_id: number | null;
}

/** Route the registry's SQL to canned responses; record every call. */
function stubDb(loadRows: LoadRow[] = [], teamId = 7): void {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM services')) return { rows: loadRows, rowCount: loadRows.length };
    if (sql.includes('FROM service_aliases')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO teams')) return { rows: [{ id: teamId }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

function callsMatching(fragment: string): unknown[][] {
  return queryMock.mock.calls.filter((c: unknown[]) => String(c[0]).includes(fragment));
}

describe('ServiceRegistry team auto-assignment', () => {
  beforeEach(() => stubDb());

  it('creates the team and assigns it when a service is first seen', async () => {
    const reg = new ServiceRegistry();
    await reg.ensure('orders-svc', { type: 'service', isExternal: false, teamName: 'Checkout' });

    const teamUpserts = callsMatching('INSERT INTO teams');
    expect(teamUpserts).toHaveLength(1);
    expect(teamUpserts[0][1]).toEqual(['Checkout']);

    const inserts = callsMatching('INSERT INTO services');
    expect(inserts).toHaveLength(1);
    // [id, type, runtime, region, isExternal, teamId]
    expect(inserts[0][1]).toEqual(['orders-svc', 'service', null, null, false, 7]);
  });

  it('inserts with a null team when no team.name is present', async () => {
    const reg = new ServiceRegistry();
    await reg.ensure('orders-svc', { type: 'service', isExternal: false });

    expect(callsMatching('INSERT INTO teams')).toHaveLength(0);
    expect(callsMatching('INSERT INTO services')[0][1]).toEqual([
      'orders-svc',
      'service',
      null,
      null,
      false,
      null,
    ]);
  });

  it('fills a missing team on a known service exactly once', async () => {
    stubDb([{ id: 'orders-svc', is_external: false, team_id: null }]);
    const reg = new ServiceRegistry();
    await reg.load();

    await reg.ensure('orders-svc', { isExternal: false, teamName: 'Checkout' });
    await reg.ensure('orders-svc', { isExternal: false, teamName: 'Checkout' });

    expect(callsMatching('INSERT INTO teams')).toHaveLength(1);
    const updates = callsMatching('team_id IS NULL');
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual(['orders-svc', 7]);
  });

  it('never overwrites an existing team assignment', async () => {
    stubDb([{ id: 'orders-svc', is_external: false, team_id: 3 }]);
    const reg = new ServiceRegistry();
    await reg.load();

    await reg.ensure('orders-svc', { isExternal: false, teamName: 'SomeOtherTeam' });

    expect(callsMatching('INSERT INTO teams')).toHaveLength(0);
    expect(callsMatching('team_id IS NULL')).toHaveLength(0);
  });

  it('assigns the team when an inferred placeholder upgrades to instrumented', async () => {
    stubDb([{ id: 'orders-svc', is_external: true, team_id: null }]);
    const reg = new ServiceRegistry();
    await reg.load();

    await reg.ensure('orders-svc', { type: 'service', isExternal: false, teamName: 'Checkout' });

    expect(callsMatching('is_external = FALSE')).toHaveLength(1);
    expect(callsMatching('INSERT INTO teams')).toHaveLength(1);
    expect(callsMatching('team_id IS NULL')).toHaveLength(1);
    expect(reg.isInternal('orders-svc')).toBe(true);
  });
});
