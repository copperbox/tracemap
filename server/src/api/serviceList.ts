import type { FastifyInstance } from 'fastify';
import { Encoded, NO_COMPRESS, sendEncoded } from '../live/encoded.js';
import { getLive } from '../live/index.js';
import type { Snapshot } from '../live/snapshot.js';
import type { RollupReader } from '../rollup/read.js';
import { aliases } from './aliases.js';
import { q } from './metrics.js';

const HOUR = 3_600_000;

/**
 * Hourly p95 over the last 24 h for every service, for the services table.
 * One fleet-wide read at most every `maxAgeMs`, shared by all viewers; a
 * stale cache is served while the refresh runs.
 */
export class SparkCache {
  private data: { at: number; version: number; spark: Map<string, number[]> } | null = null;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly reader: () => RollupReader,
    private readonly maxAgeMs = 300_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<{ version: number; spark: Map<string, number[]> }> {
    if (!this.data) await this.refresh();
    else if (this.now() - this.data.at >= this.maxAgeMs) void this.refresh().catch((err) => console.warn('spark refresh failed:', err.message));
    return this.data ?? { version: 0, spark: new Map() };
  }

  refresh(): Promise<void> {
    this.loading ??= (async () => {
      const now = this.now();
      const rows = await this.reader().read(
        { kind: 'svc_rollup', filter: {}, groupBy: ['service_id'], fromMs: now - 24 * HOUR, toMs: now, bucketMs: HOUR, hist: true },
        aliases.canonical,
      );
      rows.sort((a, b) => a.bucketMs - b.bucketMs);
      const spark = new Map<string, number[]>();
      for (const r of rows) {
        if (!r.n) continue;
        const list = spark.get(r.keys[0]) ?? [];
        list.push(q(r, 0.95) ?? 0);
        spark.set(r.keys[0], list);
      }
      this.data = { at: now, version: (this.data?.version ?? 0) + 1, spark };
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }
}

export const sparkCache = new SparkCache(() => getLive().reader);

/** The /services body for one snapshot and spark version, built once and shared. */
let body: { seq: number; spark: number; enc: Encoded } | null = null;

function listBody(snap: Snapshot, spark: Map<string, number[]>): unknown {
  return {
    edgeCount: snap.structure.edges.length,
    services: snap.structure.services.map((s) => {
      const m = snap.services.get(s.id);
      return {
        id: s.id,
        name: s.name,
        type: s.type,
        teamId: s.teamId,
        runtime: s.runtime,
        isExternal: s.isExternal,
        sloTarget: s.sloTarget,
        sloAttain: s.sloAttain,
        lastSeen: s.lastSeen,
        status: m?.status ?? 'ok',
        rps: m?.rps ?? 0,
        p95: m?.p95 ?? null,
        errPct: m?.errPct ?? 0,
        stale: m?.stale ?? true,
        spark: spark.get(s.id) ?? [],
      };
    }),
  };
}

/** GET /services: the services page listing, live numbers from the snapshot plus cached sparklines. */
export async function serviceListRoutes(app: FastifyInstance): Promise<void> {
  app.get('/services', NO_COMPRESS, async (req, reply) => {
    const [snap, spark] = await Promise.all([getLive().snapshot.current(), sparkCache.get()]);
    if (!body || body.seq !== snap.seq || body.spark !== spark.version) {
      body = { seq: snap.seq, spark: spark.version, enc: Encoded.json(listBody(snap, spark.spark)) };
    }
    return sendEncoded(req, reply, body.enc);
  });
}
