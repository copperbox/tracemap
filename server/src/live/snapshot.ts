/**
 * The live snapshot: one in-memory picture of the fleet, rebuilt every
 * SNAPSHOT_INTERVAL_MS from the collector's live window and shared by every
 * viewer. Serialized and compressed forms are built once per snapshot (lazily
 * for /topology and /services), so viewers never cause a database query.
 *
 * Database reads it does on its own schedule, never per viewer:
 * - catalog (services, edges, teams, aliases): every CATALOG_REFRESH_MS, or
 *   sooner after an edit through the API;
 * - last known state: once at start;
 * - SLO attainment (30 days): once before the first snapshot (waiting at most
 *   sloStartWaitMs), then every SLO_REFRESH_MS in the background;
 * - other collectors: their heartbeat every 10 s, and only when one is alive,
 *   their last-window 1m rows. Rows older than peerMaxAgeMs (refreshes kept
 *   failing) are no longer added; what they covered shows last-known, stale.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { AliasMap } from '../api/aliases.js';
import type { LiveAggregate, LiveWindow } from '../pipeline/cells.js';
import { SerialLoop } from '../pipeline/loop.js';
import { decodeInto, newWideHist } from '../rollup/hist.js';
import type { RollupReader } from '../rollup/read.js';
import { Encoded } from './encoded.js';
import { encodeFrame, type FrameMetrics } from './frame.js';
import {
  EMPTY_METRICS,
  addAggregates,
  canonicalize,
  computeLive,
  statusOf,
  type LiveMetrics,
  type StatusedMetrics,
} from './metrics.js';
import { StructureTracker, edgeKey, type Catalog, type LiveStructure, type StructureService } from './structure.js';

type Db = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

/** What the snapshot needs from the collector pipeline. */
export interface LiveSource {
  liveServices(now?: number): LiveWindow<string>;
  liveEdges(now?: number): LiveWindow<string>;
  readonly collectorId: number | null;
}

export interface SnapshotOptions {
  intervalMs: number;
  /** LIVE_WINDOW_MINUTES, for other collectors' rows. */
  liveWindowMinutes: number;
  catalogRefreshMs: number;
  sloRefreshMs: number;
  peersRefreshMs: number;
  /** A collector heartbeat newer than this counts as alive, ms. */
  peerAliveMs: number;
  /** Peer rows from a refresh older than this are not added to live numbers, ms. */
  peerMaxAgeMs: number;
  volatileRefreshMs: number;
  /** How long start() waits for the first SLO load before publishing without it, ms. */
  sloStartWaitMs: number;
  /** Part of every ETag, so a validator from another process never matches. */
  bootId: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_SNAPSHOT_OPTIONS: Omit<SnapshotOptions, 'intervalMs' | 'liveWindowMinutes'> = {
  catalogRefreshMs: 10_000,
  sloRefreshMs: 300_000,
  peersRefreshMs: 10_000,
  peerAliveMs: 30_000,
  peerMaxAgeMs: 30_000,
  volatileRefreshMs: 60_000,
  sloStartWaitMs: 3_000,
  bootId: randomBytes(4).toString('hex'),
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface Snapshot {
  seq: number;
  generatedAtMs: number;
  structure: LiveStructure;
  structureBody: Encoded;
  frame: Encoded;
  /** By service id. */
  services: Map<string, StatusedMetrics>;
  /** By edgeKey(source, target). */
  edges: Map<string, StatusedMetrics>;
  serviceById: Map<string, StructureService>;
  /** /topology body, serialized on first request. */
  topology(): Encoded;
}

export type PublishListener = (snap: Snapshot, structureChanged: boolean) => void;

export class LiveSnapshot {
  readonly opts: SnapshotOptions;
  private readonly startedAtMs: number;
  private readonly tracker: StructureTracker;
  private loop: SerialLoop | null = null;
  private sloLoop: SerialLoop | null = null;
  private catalog: Catalog | null = null;
  private catalogAt = -Infinity;
  private catalogDirty = false;
  private catalogChanged = false;
  private slo = new Map<string, number>();
  private sloChanged = false;
  private sloLoading: Promise<void> | null = null;
  private sloLoaded = false;
  /** at: last attempt; okAt: last success, which the rows below come from. */
  private peers: {
    at: number;
    okAt: number;
    sinceMs: number;
    ids: number[];
    svc: Map<string, LiveAggregate>;
    edges: Map<string, LiveAggregate>;
  } = {
    at: -Infinity,
    okAt: -Infinity,
    sinceMs: 0,
    ids: [],
    svc: new Map(),
    edges: new Map(),
  };
  private lastSvc = new Map<string, LiveMetrics>();
  private lastEdge = new Map<string, LiveMetrics>();
  private seq = 0;
  private snap: Snapshot | null = null;
  private building: Promise<Snapshot> | null = null;
  private listeners = new Set<PublishListener>();
  readonly stats = { builds: 0, lastBuildMs: 0, maxBuildMs: 0, frameBytes: 0, structureBytes: 0, errors: 0, lastError: null as string | null };

  constructor(
    private readonly source: LiveSource,
    private readonly db: Db,
    private readonly aliases: AliasMap,
    private readonly reader: RollupReader,
    opts: Partial<SnapshotOptions> & Pick<SnapshotOptions, 'intervalMs' | 'liveWindowMinutes'>,
  ) {
    this.opts = { ...DEFAULT_SNAPSHOT_OPTIONS, ...opts };
    this.startedAtMs = this.opts.now();
    this.tracker = new StructureTracker(this.opts.volatileRefreshMs, this.startedAtMs);
  }

  /**
   * Load last state and SLO numbers, build the first snapshot, then rebuild on
   * a timer. A slow SLO query delays the first snapshot by at most
   * sloStartWaitMs; its numbers are then published as soon as they arrive.
   */
  async start(): Promise<void> {
    const onError = (name: string, err: unknown) => this.noteError(name, err);
    await this.loadLastState();
    const slo = this.refreshSlo().catch((err) => onError('slo', err));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([slo, new Promise<void>((resolve) => (timer = setTimeout(resolve, this.opts.sloStartWaitMs)))]);
    clearTimeout(timer);
    await this.build();
    this.loop = new SerialLoop('snapshot', this.opts.intervalMs, () => this.build(), onError);
    this.sloLoop = new SerialLoop('slo', this.opts.sloRefreshMs, () => this.refreshSlo(), onError);
    this.loop.start();
    this.sloLoop.start();
  }

  private noteError(name: string, err: unknown): void {
    this.stats.errors++;
    this.stats.lastError = `${name}: ${(err as Error)?.message ?? err}`;
    console.error(`live ${name} failed:`, (err as Error)?.message ?? err);
  }

  async stop(): Promise<void> {
    await Promise.all([this.loop?.stop(), this.sloLoop?.stop()]);
    this.listeners.clear();
  }

  onPublish(fn: PublishListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The latest snapshot; builds one first if none exists yet. */
  async current(): Promise<Snapshot> {
    return this.snap ?? this.build();
  }

  get latest(): Snapshot | null {
    return this.snap;
  }

  /** Re-read the catalog on the next build (after an edit, merge or unmerge). */
  invalidateCatalog(): void {
    this.catalogDirty = true;
  }

  /** Rebuild now (or join the build in progress). */
  build(): Promise<Snapshot> {
    this.building ??= this.doBuild().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  /** Re-read catalog and rebuild right away; for API edits so the next read sees them. */
  async refreshNow(): Promise<Snapshot> {
    this.invalidateCatalog();
    if (this.building) await this.building.catch(() => {});
    return this.build();
  }

  private async doBuild(): Promise<Snapshot> {
    const started = performance.now();
    let now = this.opts.now();
    // A failed refresh keeps the previous catalog and peer rows: live numbers must keep flowing.
    if (this.catalogDirty || !this.catalog || now - this.catalogAt >= this.opts.catalogRefreshMs) {
      await this.refreshCatalog(now).catch((err) => {
        if (!this.catalog) throw err;
        this.noteError('catalog', err);
      });
    }
    if (now - this.peers.at >= this.opts.peersRefreshMs) await this.refreshPeers(now).catch((err) => this.noteError('peers', err));
    const catalog = this.catalog!;
    const canon = this.aliases.canonical;

    // The tracker only sees new input when the catalog or SLO numbers were re-read.
    // At most one version per second (see structure.ts): a change that arrives
    // sooner waits here for the second to turn, at most 1 s, so an API edit is
    // visible as soon as this build returns.
    let structureChanged = false;
    if (this.catalogChanged || this.sloChanged || this.tracker.pending || !this.tracker.structure) {
      const update = () => this.tracker.update(catalog, (id) => this.slo.get(id) ?? null, now).changed;
      structureChanged = update();
      if (this.tracker.pending) {
        await this.opts.sleep(Math.max(0, this.tracker.nextPublishAtMs - now));
        now = this.opts.now();
        structureChanged = update() || structureChanged;
      }
      this.catalogChanged = false;
      this.sloChanged = false;
    }
    const structure = this.tracker.structure;
    if (!structure) throw new Error('no structure version yet: the clock is behind the process start');

    const sw = this.source.liveServices(now);
    const ew = this.source.liveEdges(now);
    const svc = canonicalize(sw.entries, canon, false);
    const edges = canonicalize(ew.entries, canon, true);
    if (this.peers.ids.length) {
      if (now - this.peers.okAt <= this.opts.peerMaxAgeMs) {
        // Peer rows cover whole minutes from the window start to their last flush.
        const peerSeconds = Math.max(1, (now - this.peers.sinceMs) / 1000);
        addAggregates(svc, this.peers.svc, Math.min(1, sw.seconds / peerSeconds));
        addAggregates(edges, this.peers.edges, Math.min(1, ew.seconds / peerSeconds));
      } else {
        // Peer rows are too old to add, and this collector's share alone would
        // under-count: show what peers covered from last-known numbers, stale.
        for (const k of this.peers.svc.keys()) svc.delete(k);
        for (const k of this.peers.edges.keys()) edges.delete(k);
      }
    }


    const live = computeLive({
      serviceIds: structure.services.map((s) => s.id),
      edgeKeys: structure.edges.map((e) => edgeKey(structure.services[e.s].id, structure.services[e.t].id)),
      svc,
      svcSeconds: sw.seconds,
      edges,
      edgeSeconds: ew.seconds,
      lastSvc: this.lastSvc,
      lastEdge: this.lastEdge,
    });

    const seq = (this.seq = (this.seq + 1) >>> 0);
    const frameServices: FrameMetrics[] = structure.services.map((s) => live.services.get(s.id) ?? { ...EMPTY_METRICS, status: 'ok' });
    const frameEdges: FrameMetrics[] = structure.edges.map(
      (e) => live.edges.get(edgeKey(structure.services[e.s].id, structure.services[e.t].id)) ?? { ...EMPTY_METRICS, status: 'ok' },
    );
    const frame = new Encoded(
      encodeFrame({ seq, structureVersion: structure.version, generatedAtMs: now, services: frameServices, edges: frameEdges }),
      'application/octet-stream',
      `"${this.opts.bootId}-${structure.version}-${seq}"`,
    );
    const structureBody =
      this.snap && this.snap.structure === structure
        ? this.snap.structureBody
        : Encoded.json(structure, `"${this.opts.bootId}-${structure.version}"`);
    const serviceById =
      this.snap && this.snap.structure === structure ? this.snap.serviceById : new Map(structure.services.map((s) => [s.id, s]));

    let topo: Encoded | null = null;
    const snap: Snapshot = {
      seq,
      generatedAtMs: now,
      structure,
      structureBody,
      frame,
      services: live.services,
      edges: live.edges,
      serviceById,
      topology: () => (topo ??= Encoded.json(topologyBody(structure, live.services, live.edges, now))),
    };
    this.snap = snap;
    const ms = performance.now() - started;
    this.stats.builds++;
    this.stats.lastBuildMs = Math.round(ms * 10) / 10;
    this.stats.maxBuildMs = Math.max(this.stats.maxBuildMs, this.stats.lastBuildMs);
    this.stats.frameBytes = frame.raw.length;
    this.stats.structureBytes = structureBody.raw.length;
    for (const fn of this.listeners) {
      try {
        fn(snap, structureChanged);
      } catch (err) {
        console.error('live listener failed:', (err as Error).message);
      }
    }
    return snap;
  }

  private async refreshCatalog(now: number): Promise<void> {
    this.catalogDirty = false;
    const [services, edges, teams] = await Promise.all([
      this.db(
        `SELECT id, display_name, description, type, team_id, runtime, region, is_external, slo_target, first_seen, last_seen
         FROM services`,
      ),
      this.db('SELECT source_id, target_id, first_seen, last_seen, sample_count, manual FROM edges'),
      this.db('SELECT id, name FROM teams'),
      this.aliases.load(this.db),
    ]);
    const iso = (d: Date) => d.toISOString();
    this.catalog = {
      services: services.rows.map((s) => ({
        id: s.id,
        name: s.display_name ?? s.id,
        description: s.description,
        type: s.type,
        teamId: s.team_id,
        runtime: s.runtime,
        region: s.region,
        isExternal: s.is_external,
        sloTarget: s.slo_target,
        firstSeen: iso(s.first_seen),
        lastSeen: iso(s.last_seen),
      })),
      edges: edges.rows.map((e) => ({
        source: e.source_id,
        target: e.target_id,
        firstSeen: iso(e.first_seen),
        lastSeen: iso(e.last_seen),
        samples: Number(e.sample_count),
        manual: e.manual,
      })),
      teams: teams.rows.map((t) => ({ id: t.id, name: t.name })),
    };
    this.catalogAt = now;
    this.catalogChanged = true;
    // Forget last-known numbers of entities that no longer exist.
    const ids = new Set(this.catalog.services.map((s) => s.id));
    for (const id of this.lastSvc.keys()) if (!ids.has(id)) this.lastSvc.delete(id);
    const eks = new Set(this.catalog.edges.map((e) => edgeKey(e.source, e.target)));
    for (const k of this.lastEdge.keys()) if (!eks.has(k)) this.lastEdge.delete(k);
  }

  /** service_last_state / edge_last_state: what to show for entities with no traffic since start. */
  private async loadLastState(): Promise<void> {
    await this.aliases.load(this.db);
    const canon = this.aliases.canonical;
    const [svc, edges] = await Promise.all([
      this.db('SELECT service_id, at, rps, p50, p95, p99, err_pct FROM service_last_state'),
      this.db('SELECT source_id, target_id, at, rps, p50, p95, p99, err_pct FROM edge_last_state'),
    ]);
    const toM = (r: { rps: number; p50: number | null; p95: number | null; p99: number | null; err_pct: number }): LiveMetrics => ({
      rps: r.rps,
      p50: r.p50,
      p95: r.p95,
      p99: r.p99,
      errPct: r.err_pct,
      stale: true,
    });
    // Two aliases of one service: the newest row wins.
    const svcAt = new Map<string, number>();
    for (const r of svc.rows) {
      const id = canon(r.service_id);
      const at = (r.at as Date).getTime();
      if ((svcAt.get(id) ?? -Infinity) < at) {
        svcAt.set(id, at);
        this.lastSvc.set(id, toM(r));
      }
    }
    const edgeAt = new Map<string, number>();
    for (const r of edges.rows) {
      const s = canon(r.source_id);
      const t = canon(r.target_id);
      if (s === t) continue;
      const k = edgeKey(s, t);
      const at = (r.at as Date).getTime();
      if ((edgeAt.get(k) ?? -Infinity) < at) {
        edgeAt.set(k, at);
        this.lastEdge.set(k, toM(r));
      }
    }
  }

  /**
   * Other collectors' last-window rows. One cheap heartbeat query; the rows
   * are read only when another collector is alive. A peer counts only if it
   * heartbeated after this process started: the collector this one replaced
   * (a restart) measured the same traffic before, and adding it would double it.
   */
  private async refreshPeers(now: number): Promise<void> {
    this.peers.at = now;
    const me = this.source.collectorId ?? -1;
    const aliveSince = new Date(Math.max(now - this.opts.peerAliveMs, this.startedAtMs));
    const res = await this.db('SELECT id FROM collectors WHERE id <> $1 AND heartbeat_at > $2', [me, aliveSince]);
    const ids = res.rows.map((r) => r.id as number);
    if (!ids.length) {
      this.peers = { ...this.peers, okAt: now, ids, svc: new Map(), edges: new Map() };
      return;
    }
    const since = new Date((Math.floor(now / 60_000) - this.opts.liveWindowMinutes + 1) * 60_000);
    const canon = this.aliases.canonical;
    const [svc, edges] = await Promise.all([
      this.db('SELECT service_id, n, err, sum_ms, hist FROM svc_rollup_1m WHERE collector_id = ANY($1) AND bucket >= $2', [ids, since]),
      this.db('SELECT source_id, target_id, n, err, sum_ms, hist FROM edge_rollup_1m WHERE collector_id = ANY($1) AND bucket >= $2', [ids, since]),
    ]);
    const add = (into: Map<string, LiveAggregate>, key: string, r: { n: string; err: string; sum_ms: number; hist: Buffer }) => {
      let a = into.get(key);
      if (!a) {
        a = { n: 0, err: 0, sumMs: 0, hist: newWideHist() };
        into.set(key, a);
      }
      a.n += Number(r.n);
      a.err += Number(r.err);
      a.sumMs += r.sum_ms;
      if (r.hist?.length) decodeInto(r.hist, a.hist);
    };
    const svcMap = new Map<string, LiveAggregate>();
    for (const r of svc.rows) add(svcMap, canon(r.service_id), r);
    const edgeMap = new Map<string, LiveAggregate>();
    for (const r of edges.rows) {
      const s = canon(r.source_id);
      const t = canon(r.target_id);
      if (s !== t) add(edgeMap, edgeKey(s, t), r);
    }
    // Replace all of it at once, so a failure part way leaves the last good set intact.
    this.peers = { at: now, okAt: now, sinceMs: since.getTime(), ids, svc: svcMap, edges: edgeMap };
  }

  /**
   * 30-day success rate per service from the rollup tiers (daily tier plus
   * stitched recent tiers). External services take it from calls into them.
   */
  refreshSlo(): Promise<void> {
    this.sloLoading ??= (async () => {
      const now = this.opts.now();
      const DAY = 86_400_000;
      const range = { fromMs: now - 30 * DAY, toMs: now, bucketMs: DAY, filter: {} };
      const canon = this.aliases.canonical;
      const [own, inbound] = await Promise.all([
        this.reader.totals({ ...range, kind: 'svc_rollup', groupBy: ['service_id'] }, canon),
        this.reader.totals({ ...range, kind: 'edge_rollup', groupBy: ['target_id'] }, canon),
      ]);
      const attain = (n: number, err: number) => 100 - (n > 0 ? (err / n) * 100 : 0);
      const slo = new Map<string, number>();
      for (const r of own) if (r.n > 0) slo.set(r.keys[0], attain(r.n, r.err));
      for (const r of inbound) if (r.n > 0 && !slo.has(r.keys[0])) slo.set(r.keys[0], attain(r.n, r.err));
      this.slo = slo;
      this.sloChanged = true;
      // The first load must not wait for the once-a-minute volatile refresh.
      if (!this.sloLoaded) this.tracker.expireVolatile();
      this.sloLoaded = true;
    })().finally(() => {
      this.sloLoading = null;
    });
    return this.sloLoading;
  }

  /** SLO attainment for one service (shared cache). */
  sloOf(id: string): number | null {
    return this.slo.get(id) ?? null;
  }
}

/** The legacy GET /topology body, from a snapshot. */
export function topologyBody(
  structure: LiveStructure,
  services: Map<string, StatusedMetrics>,
  edges: Map<string, StatusedMetrics>,
  nowMs: number,
): unknown {
  const strip = ({ status: _s, ...m }: StatusedMetrics): LiveMetrics => m;
  const metricsOf = (m: StatusedMetrics | undefined) => (m ? strip(m) : EMPTY_METRICS);
  return {
    services: structure.services.map((s) => {
      const m = services.get(s.id);
      return { ...s, status: m?.status ?? statusOf(0), metrics: metricsOf(m) };
    }),
    edges: structure.edges.map((e) => {
      const source = structure.services[e.s].id;
      const target = structure.services[e.t].id;
      const m = edges.get(edgeKey(source, target));
      return {
        source,
        target,
        firstSeen: e.firstSeen,
        lastSeen: e.lastSeen,
        samples: e.samples,
        manual: e.manual,
        confidence: e.confidence,
        status: m?.status ?? statusOf(0),
        metrics: metricsOf(m),
      };
    }),
    teams: structure.teams,
    generatedAt: new Date(nowMs).toISOString(),
  };
}
