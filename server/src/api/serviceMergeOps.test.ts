import { describe, expect, it, vi } from 'vitest';

// refreshMergeAggregates pulls the pool `query`; stub it so importing the module
// under test never touches a real database.
vi.mock('../db/pool.js', () => ({ query: vi.fn(), pool: {} }));

import { mergeServices, unmergeServices, type Runner } from './serviceMergeOps.js';

interface Call {
  sql: string;
  params: unknown[];
}

/**
 * A stub Runner that records every call and answers the handful of SELECT/RETURNING
 * statements the ops read back from. `mergeId` is what the service_merges insert returns.
 */
function stubRunner(opts: { mergeId?: number; merged?: Record<string, unknown> | null } = {}): {
  run: Runner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const mergeId = opts.mergeId ?? 42;
  const run: Runner = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('to_jsonb(s.*)')) return { rows: [{ row: { id: 'dup', is_external: false } }] } as never;
    if (sql.includes('jsonb_agg')) return { rows: [{ rows: [] }] } as never;
    if (sql.includes('INSERT INTO service_merges')) return { rows: [{ id: mergeId }], rowCount: 1 } as never;
    if (sql.includes('FROM service_merges WHERE source_id')) {
      return opts.merged === null
        ? ({ rows: [], rowCount: 0 } as never)
        : ({
            rows: [{ id: mergeId, source_service: opts.merged ?? { id: 'dup' }, edges_snapshot: [] }],
            rowCount: 1,
          } as never);
    }
    return { rows: [], rowCount: 0 } as never;
  };
  return { run, calls };
}

const find = (calls: Call[], fragment: string) => calls.filter((c) => c.sql.includes(fragment));

describe('mergeServices', () => {
  it('snapshots the source before any destructive write', async () => {
    const { run, calls } = stubRunner();
    await mergeServices(run, 'canonical', 'dup');

    const snapshotAt = calls.findIndex((c) => c.sql.includes('to_jsonb(s.*)'));
    const deleteAt = calls.findIndex((c) => c.sql.includes('DELETE FROM services'));
    expect(snapshotAt).toBeGreaterThanOrEqual(0);
    expect(snapshotAt).toBeLessThan(deleteAt);
  });

  it('records the merge with the source/edge snapshots', async () => {
    const { run, calls } = stubRunner();
    await mergeServices(run, 'canonical', 'dup');

    const rec = find(calls, 'INSERT INTO service_merges');
    expect(rec).toHaveLength(1);
    expect(rec[0].params[0]).toBe('dup'); // source_id
    expect(rec[0].params[1]).toBe('canonical'); // target_id
    // jsonb snapshots must be JSON strings: node-postgres would otherwise send a
    // JS array as a Postgres array literal, which is invalid input for jsonb.
    expect(rec[0].params[2]).toBe(JSON.stringify({ id: 'dup', is_external: false })); // source_service
    expect(rec[0].params[3]).toBe('[]'); // edges_snapshot
  });

  it('re-points and tags telemetry with the merge id', async () => {
    const { run, calls } = stubRunner({ mergeId: 7 });
    await mergeServices(run, 'canonical', 'dup');

    const svc = find(calls, 'UPDATE spans SET service_id');
    expect(svc[0].params).toEqual(['dup', 'canonical', 7]);
    const peer = find(calls, 'UPDATE spans SET peer_service_id');
    expect(peer[0].params).toEqual(['dup', 'canonical', 7]);
    expect(find(calls, 'UPDATE edge_events SET source_id')[0].params).toEqual(['dup', 'canonical', 7]);
    expect(find(calls, 'UPDATE edge_events SET target_id')[0].params).toEqual(['dup', 'canonical', 7]);
  });

  it('aliases the duplicate and deletes its service row', async () => {
    const { run, calls } = stubRunner();
    await mergeServices(run, 'canonical', 'dup');

    expect(find(calls, 'INSERT INTO service_aliases')[0].params).toEqual(['dup', 'canonical']);
    expect(find(calls, 'DELETE FROM services')[0].params).toEqual(['dup']);
  });
});

describe('unmergeServices', () => {
  it('restores the service, telemetry and merge log, returning true', async () => {
    const { run, calls } = stubRunner({ mergeId: 7, merged: { id: 'dup', is_external: false } });
    const result = await unmergeServices(run, 'canonical', 'dup');

    expect(result).toBe(true);
    // service restored before edges are re-inserted (FK ordering)
    const restoreAt = calls.findIndex((c) => c.sql.includes('INSERT INTO services'));
    const edgeAt = calls.findIndex((c) => c.sql.includes('INSERT INTO edges'));
    expect(restoreAt).toBeGreaterThanOrEqual(0);
    expect(restoreAt).toBeLessThan(edgeAt);

    // jsonb snapshots are re-serialized to JSON strings on the way back, too.
    expect(find(calls, 'INSERT INTO services')[0].params[0]).toBe(
      JSON.stringify({ id: 'dup', is_external: false }),
    );
    expect(find(calls, 'INSERT INTO edges')[0].params[0]).toBe('[]');

    expect(find(calls, 'UPDATE spans SET service_id')[0].params).toEqual(['dup', 7]);
    expect(find(calls, 'svc_merge = NULL')[0].params).toEqual(['dup', 7]);
    expect(find(calls, 'DELETE FROM service_aliases')[0].params).toEqual(['dup']);
    expect(find(calls, 'DELETE FROM service_merges')[0].params).toEqual([7]);
  });

  it('writes nothing and returns false when no merge is recorded', async () => {
    const { run, calls } = stubRunner({ merged: null });
    const result = await unmergeServices(run, 'canonical', 'dup');

    expect(result).toBe(false);
    expect(calls).toHaveLength(1); // only the lookup ran
    expect(find(calls, 'UPDATE spans')).toHaveLength(0);
  });
});
