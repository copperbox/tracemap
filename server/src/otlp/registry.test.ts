import { describe, expect, it, vi } from 'vitest';
import { ServiceRegistry } from './registry.js';

interface LoadRow {
  id: string;
  is_external: boolean;
  team_id: number | null;
}

/** A fake db that answers the load queries and records every statement. */
function fakeDb(loadRows: LoadRow[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  let fail = false;
  const db = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (fail) throw new Error('db down');
    if (sql.includes('FROM services')) return { rows: loadRows, rowCount: loadRows.length };
    return { rows: [], rowCount: 0 };
  });
  const matching = (frag: string) => calls.filter((c) => c.sql.includes(frag));
  return { db: db as never, calls, matching, setFail: (v: boolean) => (fail = v) };
}

describe('ServiceRegistry notes', () => {
  it('note() is synchronous and touches no database', () => {
    const f = fakeDb();
    const reg = new ServiceRegistry(f.db);
    reg.note('orders', { type: 'service', isExternal: false, teamName: 'Checkout' });
    expect(f.calls).toHaveLength(0);
    expect(reg.has('orders')).toBe(true);
    expect(reg.isInternal('orders')).toBe(true);
    expect(reg.pending).toEqual({ services: 1, seen: 1, edges: 0 });
  });

  it('flush inserts teams and new services in one statement each', async () => {
    const f = fakeDb();
    const reg = new ServiceRegistry(f.db);
    reg.note('orders', { type: 'service', isExternal: false, teamName: 'Checkout' });
    reg.note('pg-orders', { type: 'postgres', isExternal: true });
    reg.note('orders', { type: 'service', isExternal: false, teamName: 'Checkout' });
    await reg.flush();
    expect(f.matching('INSERT INTO teams')).toHaveLength(1);
    expect(f.matching('INSERT INTO teams')[0].params).toEqual([['Checkout']]);
    const ins = f.matching('INSERT INTO services');
    expect(ins).toHaveLength(1);
    expect(ins[0].params).toEqual([
      ['orders', 'pg-orders'],
      ['service', 'postgres'],
      [null, null],
      [null, null],
      [false, true],
      ['Checkout', null],
    ]);
    // Both were written by the insert, so no separate last_seen update.
    expect(f.matching('UPDATE services SET last_seen')).toHaveLength(0);
    expect(reg.pending).toEqual({ services: 0, seen: 0, edges: 0 });
  });

  it('updates last_seen for known services in one statement', async () => {
    const f = fakeDb([
      { id: 'a', is_external: false, team_id: 1 },
      { id: 'b', is_external: false, team_id: 1 },
    ]);
    const reg = new ServiceRegistry(f.db);
    await reg.load();
    for (let i = 0; i < 100; i++) {
      reg.note('a', { isExternal: false });
      reg.note('b', { isExternal: false });
    }
    await reg.flush();
    expect(f.matching('INSERT INTO services')).toHaveLength(0);
    const up = f.matching('UPDATE services SET last_seen');
    expect(up).toHaveLength(1);
    expect(up[0].params).toEqual([['a', 'b']]);
  });

  it('fills a missing team on a known service exactly once, never overwrites one', async () => {
    const f = fakeDb([
      { id: 'orders', is_external: false, team_id: null },
      { id: 'billing', is_external: false, team_id: 3 },
    ]);
    const reg = new ServiceRegistry(f.db);
    await reg.load();
    reg.note('orders', { isExternal: false, teamName: 'Checkout' });
    reg.note('billing', { isExternal: false, teamName: 'Other' });
    await reg.flush();
    reg.note('orders', { isExternal: false, teamName: 'Checkout' });
    await reg.flush();
    const ins = f.matching('INSERT INTO services');
    expect(ins).toHaveLength(1);
    expect(ins[0].params[0]).toEqual(['orders']);
    // The SQL itself also guards against overwriting.
    expect(ins[0].sql).toContain('COALESCE(services.team_id, EXCLUDED.team_id)');
  });

  it('upgrades an inferred placeholder to instrumented', async () => {
    const f = fakeDb([{ id: 'orders', is_external: true, team_id: null }]);
    const reg = new ServiceRegistry(f.db);
    await reg.load();
    expect(reg.isInternal('orders')).toBe(false);
    reg.note('orders', { type: 'service', isExternal: false, teamName: 'Checkout' });
    expect(reg.isInternal('orders')).toBe(true);
    await reg.flush();
    const ins = f.matching('INSERT INTO services');
    expect(ins[0].params[4]).toEqual([false]);
    expect(ins[0].sql).toContain('services.is_external AND EXCLUDED.is_external');
  });

  it('batches learned edges and keeps notes after a failed flush', async () => {
    const f = fakeDb();
    const reg = new ServiceRegistry(f.db);
    reg.note('a', { isExternal: false });
    reg.noteEdge('a', 'b');
    reg.noteEdge('a', 'b');
    reg.noteEdge('a', 'c');
    f.setFail(true);
    await expect(reg.flush()).rejects.toThrow('db down');
    expect(reg.pending).toEqual({ services: 1, seen: 1, edges: 2 });
    reg.noteEdge('a', 'b');
    f.setFail(false);
    await reg.flush();
    const e = f.matching('INSERT INTO edges').at(-1)!;
    expect(e.params).toEqual([
      ['a', 'a'],
      ['b', 'c'],
      [3, 1],
    ]);
  });

  it('resolves aliases to the canonical id', async () => {
    const f = fakeDb();
    const reg = new ServiceRegistry(async (sql: string) =>
      sql.includes('service_aliases')
        ? ({ rows: [{ alias: 'orders-v2', service_id: 'orders' }] } as never)
        : (f.db as (s: string) => never)(sql),
    );
    await reg.load();
    expect(reg.resolve('orders-v2')).toBe('orders');
    expect(reg.resolve('x')).toBe('x');
  });
});
