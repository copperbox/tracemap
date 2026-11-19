import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { ServiceRegistry } from '../otlp/registry.js';
import { Pipeline } from './pipeline.js';

/** A pool whose svc_rollup write fails at once and whose op_rollup write waits for `release`. */
function fakePool() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const settled: string[] = [];
  const client = {
    async query(q: string | { text: string }) {
      const text = typeof q === 'string' ? q : q.text;
      if (text.includes('INSERT INTO svc_rollup_1m')) throw new Error('svc write failed');
      if (text.includes('INSERT INTO op_rollup_1m')) {
        await gate;
        settled.push('op');
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = { connect: async () => client, query: client.query } as unknown as pg.Pool;
  return { pool, release, settled };
}

describe('Pipeline.flushRollups', () => {
  it('waits for every table write to settle before restoring state after a failure', async () => {
    const { pool, release, settled } = fakePool();
    const registry = new ServiceRegistry(async () => ({ rows: [], rowCount: 0 }) as never);
    const p = new Pipeline(config, pool, registry);
    p.collectorId = 1;
    const now = Date.now();
    const m = Math.floor(now / 60_000);
    p.cells.addRequest(m, 'a', 'GET /', 5, false, null);

    let done = false;
    const flush = p.flushRollups(now).then(
      () => { done = true; },
      (err: Error) => { done = true; return err; },
    );
    await new Promise((r) => setTimeout(r, 20));
    // svc failed long ago, but op is still in flight: the flush must not have returned.
    expect(done).toBe(false);
    release();
    const err = await flush;
    expect((err as Error).message).toBe('svc write failed');
    expect(settled).toEqual(['op']);
    // Every cell is dirty again for the next flush.
    expect(p.cells.takeDirty().rows).toBe(2);
  });
});
