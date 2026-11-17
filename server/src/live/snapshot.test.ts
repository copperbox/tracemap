import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { AliasMap } from '../api/aliases.js';
import type { LiveAggregate } from '../pipeline/cells.js';
import { addValue, encode, newHist, newWideHist } from '../rollup/hist.js';
import type { ReadQuery, ReadRow, RollupReader } from '../rollup/read.js';
import { decodeFrame, frameBytes } from './frame.js';
import { LiveSnapshot, type SnapshotOptions } from './snapshot.js';
import { SseHub, attachHub } from './sse.js';
import { edgeKey } from './structure.js';

const T0 = Date.UTC(2026, 10, 17, 12);
const DATE = new Date(T0 - 86_400_000);

function agg(n: number, err: number, ms: number): LiveAggregate {
  const hist = newWideHist();
  for (let i = 0; i < n; i++) addValue(hist, ms);
  return { n, err, sumMs: n * ms, hist };
}

/** A small fleet: a -> b, both with live traffic from this collector. */
function fixture(opts: { peers?: boolean; sloDelayMs?: number } = {}) {
  let now = T0;
  const clock = { get: () => now, set: (v: number) => (now = v) };
  const db = {
    failPeers: false,
    peerIds: opts.peers ? [7] : [],
  };
  const query = async (text: string): Promise<pg.QueryResult> => {
    const rows = (r: unknown[]) => ({ rows: r, rowCount: r.length }) as unknown as pg.QueryResult;
    if (text.includes('FROM services'))
      return rows(
        ['a', 'b'].map((id) => ({
          id,
          display_name: null,
          description: null,
          type: 'service',
          team_id: null,
          runtime: null,
          region: null,
          is_external: false,
          slo_target: 99.9,
          first_seen: DATE,
          last_seen: DATE,
        })),
      );
    if (text.includes('FROM edges'))
      return rows([{ source_id: 'a', target_id: 'b', first_seen: DATE, last_seen: DATE, sample_count: '10', manual: false }]);
    if (text.includes('FROM collectors')) {
      if (db.failPeers) throw new Error('db down');
      return rows(db.peerIds.map((id) => ({ id })));
    }
    if (text.includes('svc_rollup_1m')) {
      if (db.failPeers) throw new Error('db down');
      const h = newHist();
      for (let i = 0; i < 300; i++) addValue(h, 10);
      return rows([{ service_id: 'a', n: '300', err: '0', sum_ms: 3000, hist: encode(h) }]);
    }
    return rows([]);
  };
  const reader = {
    async totals(q: ReadQuery): Promise<ReadRow[]> {
      if (opts.sloDelayMs) await new Promise((r) => setTimeout(r, opts.sloDelayMs));
      if (q.kind !== 'svc_rollup') return [];
      return [{ bucketMs: 0, keys: ['a'], n: 1000, err: 1, sumMs: 0, hist: null, sample: null, sampleAtMs: null }];
    },
  } as unknown as RollupReader;
  const source = {
    collectorId: 1,
    liveServices: () => ({ fromMs: now - 60_000, toMs: now, seconds: 60, entries: new Map([['a', agg(60, 0, 10)], ['b', agg(60, 0, 10)]]) }),
    liveEdges: () => ({ fromMs: now - 60_000, toMs: now, seconds: 60, entries: new Map([[edgeKey('a', 'b'), agg(60, 0, 10)]]) }),
  };
  const sleeps: number[] = [];
  const options: Partial<SnapshotOptions> & Pick<SnapshotOptions, 'intervalMs' | 'liveWindowMinutes'> = {
    intervalMs: 1e9,
    liveWindowMinutes: 5,
    sloRefreshMs: 1e9,
    bootId: 'boot1',
    now: clock.get,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  const snapshot = new LiveSnapshot(source, query, new AliasMap(), reader, options);
  return { snapshot, clock, db, sleeps, options, source, query, reader };
}

describe('LiveSnapshot', () => {
  it('waits for the second after the process start before the first version, and puts the boot id in ETags', async () => {
    const f = fixture();
    const snap = await f.snapshot.build();
    expect(f.sleeps).toEqual([1000]);
    expect(snap.structure.version).toBe(T0 / 1000 + 1);
    expect(snap.structureBody.etag).toBe(`"boot1-${snap.structure.version}"`);
    expect(snap.frame.etag).toBe(`"boot1-${snap.structure.version}-${snap.seq}"`);
  });

  it('builds a frame of exactly the documented size', async () => {
    const f = fixture();
    const snap = await f.snapshot.build();
    const ns = snap.structure.services.length;
    const ne = snap.structure.edges.length;
    expect(snap.frame.raw.byteLength).toBe(32 + 20 * (ns + ne) + ns + ne);
    expect(snap.frame.raw.byteLength).toBe(frameBytes(ns, ne));
    expect(decodeFrame(snap.frame.raw).services).toHaveLength(ns);
  });

  it('publishes a snapshot, and a metrics notice, on every build even when nothing changed', async () => {
    const f = fixture();
    const hub = new SseHub();
    const writes: string[] = [];
    const res = {
      writableLength: 0,
      writableNeedDrain: false,
      destroyed: false,
      writableEnded: false,
      socket: null,
      writeHead: () => res,
      write: (c: string) => writes.push(c),
      once: () => res,
      end: () => {},
    };
    hub.add(res as never, {}, '');
    attachHub(f.snapshot, hub);
    await f.snapshot.build();
    f.clock.set(f.clock.get() + 2000);
    await f.snapshot.build();
    f.clock.set(f.clock.get() + 2000);
    await f.snapshot.build();
    const notices = writes.slice(1);
    expect(notices).toHaveLength(3);
    expect(notices[0]).toMatch(/^event: structure\n.*\n\nevent: metrics\n/);
    expect(notices[1]).toMatch(/^event: metrics\ndata: \{"seq":2,/);
    expect(notices[2]).toMatch(/^event: metrics\ndata: \{"seq":3,/);
    hub.close();
  });

  it('has SLO attainment in the first structure when the SLO query is quick', async () => {
    const f = fixture();
    // start() would also begin timers; drive its steps the same way.
    await f.snapshot.refreshSlo();
    const snap = await f.snapshot.build();
    expect(snap.structure.services.find((s) => s.id === 'a')!.sloAttain).toBeCloseTo(99.9, 9);
  });

  it('start() does not wait long for a slow SLO query and publishes it as soon as it lands', async () => {
    const f = fixture({ sloDelayMs: 300 });
    const s = new LiveSnapshot(f.source, f.query, new AliasMap(), f.reader, { ...f.options, sloStartWaitMs: 50 });
    const t = performance.now();
    await s.start();
    expect(performance.now() - t).toBeLessThan(250);
    const first = s.latest!;
    expect(first.structure.services[0].sloAttain).toBeNull();
    await new Promise((r) => setTimeout(r, 400));
    // Next build (a couple of seconds later) carries it without the once-a-minute wait.
    f.clock.set(f.clock.get() + 2000);
    const next = await s.build();
    await s.stop();
    expect(next.structure.version).toBeGreaterThan(first.structure.version);
    expect(next.structure.services.find((x) => x.id === 'a')!.sloAttain).toBeCloseTo(99.9, 9);
  });

  it('adds fresh peer rows, then stops adding them once refreshes keep failing', async () => {
    const f = fixture({ peers: true });
    const s = new LiveSnapshot(f.source, f.query, new AliasMap(), f.reader, { ...f.options, peersRefreshMs: 10_000, peerMaxAgeMs: 30_000 });
    const first = await s.build();
    const a1 = first.services.get('a')!;
    // 60 local spans per 60 s plus 300 peer spans scaled to the same window.
    expect(a1.rps).toBeGreaterThan(1);
    expect(a1.stale).toBe(false);
    expect(first.services.get('b')!.rps).toBeCloseTo(1, 9);

    f.db.failPeers = true;
    f.clock.set(f.clock.get() + 20_000);
    const within = await s.build();
    // Still within peerMaxAgeMs: the cached peer rows are added (local alone is 1/s).
    expect(within.services.get('a')!.rps).toBeGreaterThan(1.5);
    expect(within.services.get('a')!.stale).toBe(false);

    f.clock.set(f.clock.get() + 20_000);
    const expired = await s.build();
    // Peer-covered entities fall back to the last full numbers, flagged stale.
    expect(expired.services.get('a')).toMatchObject({ rps: within.services.get('a')!.rps, stale: true });
    // Entities only this collector sees stay live.
    expect(expired.services.get('b')!.stale).toBe(false);

    f.db.failPeers = false;
    f.clock.set(f.clock.get() + 10_000);
    const recovered = await s.build();
    expect(recovered.services.get('a')!.stale).toBe(false);
  });
});
