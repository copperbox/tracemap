import { hostname } from 'node:os';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type pg from 'pg';
import { errorSignature } from '../api/errorSignature.js';
import type { Config } from '../config.js';
import type { NormalizedResourceSpans, NormalizedSpan } from '../otlp/decode.js';
import { inferOwnType, inferPeer, regionOf, runtimeOf, teamOf } from '../otlp/infer.js';
import type { ServiceRegistry } from '../otlp/registry.js';
import { compactOnce, DEFAULT_COMPACT_OPTIONS, write1mRows, type CompactResult } from '../rollup/compact.js';
import { CellStore, splitEdgeKey, type LiveWindow, type SigRef } from './cells.js';
import { EdgePairing, type EdgeObservation, type EdgePairingStats } from './edgePairing.js';
import { KeptWriter, type KeptWriterStats } from './keptWriter.js';
import { SerialLoop } from './loop.js';
import { summarize } from './summary.js';
import { TraceBuffer, type SpanInput, type TraceBufferStats } from './traceBuffer.js';

const KIND_SERVER = 2;
const KIND_CLIENT = 3;
const KIND_PRODUCER = 4;
const KIND_CONSUMER = 5;
const MINUTE_MS = 60_000;
/** Root-operation p99 for the "slow" rule needs at least this many recent spans. */
const SLOW_MIN_SAMPLES = 50;
/** Rows per rollup upsert statement. */
const UPSERT_CHUNK = 10_000;

export type PipelineOptions = Config;

export interface IngestResult {
  spans: number;
  edgeObservations: number;
}

/**
 * ingestTraces() failed part way. `started` says whether any span was
 * already (perhaps partly) counted: if so a retry of the batch would count it
 * twice, so the route must not answer a retryable status.
 */
export class IngestError extends Error {
  constructor(
    readonly accepted: number,
    readonly started: boolean,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Why ingest is refusing work right now. */
export type OverloadReason = 'event-loop-lag' | 'inflight' | 'rollup-backlog';

export type GateResult = { ok: true } | { ok: false; reason: OverloadReason; retryAfterSec: number };

/** Duration of the most recent runs of a background job, ms. */
export interface JobStats {
  runs: number;
  failures: number;
  lastMs: number;
  maxMs: number;
  /** Mean of the last up to 20 runs. */
  avgMs: number;
  lastAt: string | null;
}

/** Snapshot of everything the collector counts; served by /api/health. */
export interface PipelineStats {
  collectorId: number | null;
  startedAt: string;
  uptimeSec: number;
  /** Process memory, MB. */
  memory: { rssMB: number; heapUsedMB: number; heapTotalMB: number; externalMB: number };
  spans: {
    /** Spans accepted since start. */
    accepted: number;
    /** Spans accepted in the last 60 s. */
    lastMinute: number;
    /** Cell writes whose span start was older than the grace window (counted into the oldest open minute). */
    clampedPast: number;
    /** Cell writes whose span start was in the future (counted into the current minute). */
    clampedFuture: number;
  };
  requests: { ok: number; malformed: number; overloaded: number; failed: number; inflight: number };
  overload: { eventLoopLagMs: number; lastReason: OverloadReason | null };
  rollup: {
    minutesInMemory: number;
    cells: number;
    /** Closed minutes still waiting to be written. */
    backlogMinutes: number;
    rowsWritten: number;
    flush: JobStats;
  };
  edges: EdgePairingStats & { observations: number };
  traces: TraceBufferStats;
  kept: KeptWriterStats & { flush: JobStats };
  catalog: { pendingServices: number; pendingEdges: number; flush: JobStats };
  compaction: { lastResult: Omit<CompactResult, 'watermarks'> | null; job: JobStats };
  lastState: JobStats;
  heartbeat: JobStats;
  lastError: { at: string; where: string; message: string } | null;
}

class JobTimer {
  runs = 0;
  failures = 0;
  lastMs = 0;
  maxMs = 0;
  lastAt: string | null = null;
  private recent: number[] = [];

  async time<T>(fn: () => Promise<T>): Promise<T> {
    const t = performance.now();
    try {
      return await fn();
    } catch (err) {
      this.failures++;
      throw err;
    } finally {
      const ms = performance.now() - t;
      this.runs++;
      this.lastMs = ms;
      this.maxMs = Math.max(this.maxMs, ms);
      this.lastAt = new Date().toISOString();
      this.recent.push(ms);
      if (this.recent.length > 20) this.recent.shift();
    }
  }

  stats(): JobStats {
    const avg = this.recent.length ? this.recent.reduce((a, b) => a + b, 0) / this.recent.length : 0;
    return { runs: this.runs, failures: this.failures, lastMs: round(this.lastMs), maxMs: round(this.maxMs), avgMs: round(avg), lastAt: this.lastAt };
  }
}

const round = (v: number) => Math.round(v * 10) / 10;

function memoryMB(): PipelineStats['memory'] {
  const m = process.memoryUsage();
  const mb = (b: number) => Math.round(b / 1048576);
  return { rssMB: mb(m.rss), heapUsedMB: mb(m.heapUsed), heapTotalMB: mb(m.heapTotal), externalMB: mb(m.external + m.arrayBuffers) };
}

/** Text columns reject NUL; strip it from names before they become keys. */
function clean(s: string): string {
  return s.includes('\u0000') ? s.replace(/\u0000/g, '') : s;
}

function httpStatusOf(attrs: Record<string, unknown>): number | null {
  const v = attrs['http.response.status_code'] ?? attrs['http.status_code'];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * The collector pipeline. ingestTraces() is synchronous and never touches the
 * database: it folds spans into rollup cells, pairs edges and buffers traces.
 * Background loops write rollups, kept traces, the catalog, last-state rows
 * and heartbeats, and run tier compaction.
 */
export class Pipeline {
  readonly cells: CellStore;
  readonly edges: EdgePairing;
  readonly traces: TraceBuffer;
  readonly kept: KeptWriter;
  /** collectors.id of this process; null until start(). */
  collectorId: number | null = null;
  readonly startedAtMs: number;

  private loops: SerialLoop[] = [];
  private lag: IntervalHistogram | null = null;
  private lagMs = 0;
  private scratch: SpanInput;
  private secondCounts = new Float64Array(60);
  private secondAt = 0;
  private c = {
    accepted: 0,
    edgeObservations: 0,
    rowsWritten: 0,
    req: { ok: 0, malformed: 0, overloaded: 0, failed: 0 },
    lastReason: null as OverloadReason | null,
  };
  inflight = 0;
  private jobs = {
    rollup: new JobTimer(),
    kept: new JobTimer(),
    catalog: new JobTimer(),
    compact: new JobTimer(),
    lastState: new JobTimer(),
    heartbeat: new JobTimer(),
  };
  private lastCompact: Omit<CompactResult, 'watermarks'> | null = null;
  private readonly isInternal = (id: string): boolean => this.registry.isInternal(id);
  private lastError: PipelineStats['lastError'] = null;
  private stopping = false;

  constructor(
    readonly opts: PipelineOptions,
    private readonly pool: pg.Pool,
    readonly registry: ServiceRegistry,
    now = Date.now(),
  ) {
    this.startedAtMs = now;
    this.cells = new CellStore(
      {
        graceMinutes: Math.max(1, opts.rollupGraceMinutes),
        liveMinutes: opts.liveWindowMinutes,
        maxOpsPerService: opts.maxOpsPerService,
        maxErrorSigsPerService: opts.maxErrorSigsPerService,
      },
      now,
    );
    this.edges = new EdgePairing(
      { ttlMs: opts.edgeResolveTtlMs, maxPending: opts.edgeResolveMaxPending, resolvedCapacity: opts.edgeResolvedCapacity },
      now,
    );
    this.kept = new KeptWriter(pool, opts.keptQueueMaxSpans);
    this.traces = new TraceBuffer(
      {
        decisionWaitMs: opts.traceDecisionWaitMs,
        maxAgeMs: opts.traceMaxAgeMs,
        maxSpans: opts.traceBufferMaxSpans,
        maxSpansPerTrace: opts.traceMaxSpansPerTrace,
        errorQuota: opts.keepErrorQuota,
        slowQuota: opts.keepSlowQuota,
        baselineQuota: opts.keepBaselineQuota,
        keptSpansPerSec: opts.keptSpansPerSec,
        baselineShare: opts.keepBaselineShare,
        initialBudgetSpans: opts.keptBudgetInitialSpans,
        decidedTtlMs: opts.traceDecidedTtlMs,
        decidedCapacity: opts.traceDecidedCapacity,
      },
      this.kept,
      {
        rootP99: (service, op, at) => this.rootP99(service, op, at),
        onErrorKeep: (ref: SigRef, traceId: string) => this.cells.setSample(ref, traceId),
      },
      now,
    );
    this.scratch = {
      traceId: '', spanId: '', parentSpanId: null, serviceId: '', peerServiceId: null, name: '', kind: 0,
      startMs: 0, durationMs: 0, isError: false, isRoot: false, httpStatus: null, attrs: {}, sigRef: null, rootOp: null,
    };
  }

  // ---- lifecycle ----

  /** Register this process in `collectors` and start the background loops. */
  async start(): Promise<void> {
    const res = await this.pool.query<{ id: number }>(
      'INSERT INTO collectors (host) VALUES ($1) RETURNING id',
      [`${hostname()}:${process.pid}`],
    );
    this.collectorId = res.rows[0].id;
    this.lag = monitorEventLoopDelay({ resolution: 20 });
    this.lag.enable();
    const onError = (where: string, err: unknown) => this.recordError(where, err);
    const o = this.opts;
    this.loops = [
      new SerialLoop('tick', 1000, () => this.tick(), onError),
      new SerialLoop('rollup-flush', o.rollupFlushMs, () => this.flushRollups(), onError),
      new SerialLoop('kept-flush', 1000, () => this.flushKept(), onError),
      new SerialLoop('catalog-flush', o.catalogFlushMs, () => this.flushCatalog(), onError),
      new SerialLoop('compaction', o.compactIntervalMs, () => this.compact(), onError),
      new SerialLoop('last-state', o.lastStateMs, () => this.writeLastState(), onError),
      new SerialLoop('heartbeat', o.heartbeatMs, () => this.heartbeat(), onError),
    ];
    for (const l of this.loops) l.start();
  }

  /**
   * Stop loops, decide every buffered trace, and flush rollup cells, kept
   * traces and the catalog. Ingest should already be closed.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.loops.map((l) => l.stop()));
    this.lag?.disable();
    this.traces.decideAll();
    const steps: [string, () => Promise<unknown>][] = [
      ['catalog-flush', () => this.flushCatalog()],
      ['rollup-flush', () => this.flushRollups()],
      ['kept-flush', () => this.kept.drain()],
      ['last-state', () => this.writeLastState()],
      ['heartbeat', () => this.heartbeat()],
    ];
    for (const [where, fn] of steps) {
      try {
        await fn();
      } catch (err) {
        this.recordError(where, err);
      }
    }
  }

  private tick(now = Date.now()): void {
    this.traces.sweep(now);
    this.edges.sweep(now);
    if (this.lag) {
      this.lagMs = this.lag.max / 1e6;
      this.lag.reset();
    }
  }

  private recordError(where: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.lastError = { at: new Date().toISOString(), where, message };
    console.error(`pipeline ${where} failed:`, message);
  }

  // ---- ingest (hot path, synchronous) ----

  /** Should ingest take more work right now? */
  gate(now = Date.now()): GateResult {
    let reason: OverloadReason | null = null;
    let retryAfterSec = 1;
    if (this.cells.backlogMinutes(now) > this.opts.rollupMaxBacklogMinutes) {
      reason = 'rollup-backlog';
      retryAfterSec = 10;
    } else if (this.inflight > this.opts.overloadMaxInflight) {
      reason = 'inflight';
    } else if (this.lagMs > this.opts.overloadLagMs) {
      reason = 'event-loop-lag';
      retryAfterSec = Math.min(30, Math.ceil(this.lagMs / 1000));
    }
    if (!reason) return { ok: true };
    this.c.lastReason = reason;
    return { ok: false, reason, retryAfterSec };
  }

  /** Request outcome counters, for stats. */
  countRequest(kind: 'ok' | 'malformed' | 'overloaded' | 'failed'): void {
    this.c.req[kind]++;
  }

  /**
   * Fold decoded spans into cells, edge pairing and the trace buffer. Never
   * awaits. Throws IngestError if it fails part way.
   */
  ingestTraces(batches: NormalizedResourceSpans[], now = Date.now()): IngestResult {
    let spans = 0;
    let started = false;
    const edgesBefore = this.c.edgeObservations;
    const reg = this.registry;
    try {
      for (const batch of batches) {
        if (!batch.serviceName || !batch.spans.length) continue;
        const serviceId = reg.resolve(clean(batch.serviceName));
        const attrs = batch.resourceAttrs;
        if (!reg.touch(serviceId, attrs['team.name'] != null)) {
          reg.note(serviceId, {
            type: inferOwnType(serviceId),
            runtime: runtimeOf(attrs),
            region: regionOf(attrs),
            teamName: teamOf(attrs),
            isExternal: false,
          });
        }
        started = true;
        for (const span of batch.spans) {
          this.ingestSpan(serviceId, span, now);
          spans++;
        }
      }
    } catch (err) {
      throw new IngestError(spans, started, err);
    } finally {
      this.c.accepted += spans;
      this.countSecond(spans, now);
    }
    return { spans, edgeObservations: this.c.edgeObservations - edgesBefore };
  }

  private ingestSpan(serviceId: string, span: NormalizedSpan, now: number): void {
    const startMs = Number(span.startUnixNano) / 1e6;
    const d = Number(span.endUnixNano - span.startUnixNano) / 1e6;
    const durationMs = d > 0 && Number.isFinite(d) ? d : 0;
    const httpStatus = httpStatusOf(span.attrs);
    const isError = span.statusCode === 2 || (httpStatus != null && httpStatus >= 500);
    const isRoot = !span.parentSpanId;
    const kind = span.kind;
    const name = clean(span.name);
    const sig = isError ? errorSignature(span.attrs, httpStatus) : null;

    let sigRef: SigRef | null = null;
    let rootOp: string | null = null;
    if (kind === KIND_SERVER || kind === KIND_CONSUMER || isRoot) {
      const minute = this.cells.minuteFor(startMs, now);
      const r = this.cells.addRequest(minute, serviceId, name, durationMs, isError, sig);
      sigRef = r.sigRef;
      if (isRoot) rootOp = r.op;
    }

    let ob: EdgeObservation | null = null;
    if (kind === KIND_CLIENT || kind === KIND_PRODUCER) {
      const raw = inferPeer(span.attrs, this.isInternal);
      const guess = raw
        ? { ...raw, id: this.registry.resolve(raw.id), isExternal: !this.registry.isInternal(raw.id) && raw.isExternal }
        : null;
      ob = this.edges.onClientSpan(
        {
          spanId: span.spanId,
          serviceId,
          operation: name,
          timeMs: startMs,
          durationMs,
          isError,
          errCode: sig?.code,
          errMessage: sig?.message ?? undefined,
          peerGuess: guess,
        },
        now,
      );
    } else if (kind === KIND_SERVER || kind === KIND_CONSUMER) {
      ob = this.edges.onServerSpan(span.parentSpanId, serviceId, now);
    }
    let peer: string | null = null;
    if (ob) {
      const edgeRef = this.recordEdge(ob, now);
      if (ob.sourceId === serviceId && (kind === KIND_CLIENT || kind === KIND_PRODUCER)) {
        peer = ob.targetId;
        sigRef ??= edgeRef;
      }
    }

    const s = this.scratch;
    s.traceId = span.traceId;
    s.spanId = span.spanId;
    s.parentSpanId = span.parentSpanId;
    s.serviceId = serviceId;
    s.peerServiceId = peer;
    s.name = name;
    s.kind = kind;
    s.startMs = startMs;
    s.durationMs = durationMs;
    s.isError = isError;
    s.isRoot = isRoot;
    s.httpStatus = httpStatus;
    s.attrs = span.attrs;
    s.sigRef = sigRef;
    s.rootOp = rootOp;
    this.traces.add(s, now);
  }

  private recordEdge(ob: EdgeObservation, now: number): SigRef | null {
    this.c.edgeObservations++;
    if (ob.targetGuess && !this.registry.has(ob.targetId)) {
      this.registry.note(ob.targetId, { type: ob.targetGuess.type, isExternal: true });
    }
    this.registry.noteEdge(ob.sourceId, ob.targetId);
    const minute = this.cells.minuteFor(ob.timeMs, now);
    const sig = ob.isError && ob.errCode ? { code: ob.errCode, message: ob.errMessage ?? null } : null;
    return this.cells.addEdge(minute, ob.sourceId, ob.targetId, ob.operation, ob.durationMs, ob.isError, sig);
  }

  /** Services seen in /v1/metrics: registered, nothing else stored. */
  noteMetricServices(names: Iterable<string>): void {
    for (const raw of names) {
      const id = this.registry.resolve(clean(raw));
      if (!this.registry.touch(id, false)) this.registry.note(id, { type: inferOwnType(id), isExternal: false });
    }
  }

  private countSecond(n: number, now: number): void {
    const sec = Math.floor(now / 1000);
    if (sec !== this.secondAt) {
      // Clear the slots skipped since the last call.
      const gap = Math.min(60, sec - this.secondAt);
      for (let i = 1; i <= gap; i++) this.secondCounts[(this.secondAt + i) % 60] = 0;
      this.secondAt = sec;
    }
    this.secondCounts[sec % 60] += n;
  }

  private spansLastMinute(now: number): number {
    this.countSecond(0, now);
    let t = 0;
    for (let i = 0; i < 60; i++) t += this.secondCounts[i];
    return t;
  }

  private rootP99(service: string, op: string, now: number): number {
    const m = Math.floor(now / MINUTE_MS);
    const h = this.cells.opHist(service, op, m - 1, m);
    if (!h) return NaN;
    let n = 0;
    for (let i = 0; i < h.length; i++) n += h[i];
    if (n < SLOW_MIN_SAMPLES) return NaN;
    return summarize({ n, err: 0, sumMs: 0, hist: h }, 1).p99 ?? NaN;
  }

  // ---- background writers ----

  /**
   * Upsert every changed rollup cell: one transaction per table (chunked
   * statements when huge), which also marks already-compacted windows dirty.
   */
  async flushRollups(now = Date.now()): Promise<number> {
    if (this.collectorId == null) return 0;
    const collectorId = this.collectorId;
    return this.jobs.rollup.time(async () => {
      const snap = this.cells.takeDirty();
      // Wait for every table's write to settle before touching cell state, so
      // no write from this flush is still in flight when the next one starts.
      const results = await Promise.allSettled(
        snap.batches.map((b) => write1mRows(this.pool, b.kind, b, collectorId, UPSERT_CHUNK)),
      );
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) {
        // Rewriting the tables that did succeed is harmless: rows are replaced whole.
        this.cells.restoreDirty(snap);
        throw failed.reason;
      }
      this.c.rowsWritten += snap.rows;
      this.cells.retire(now);
      return snap.rows;
    });
  }

  async flushKept(): Promise<void> {
    if (!this.kept.queuedSpans) return;
    await this.jobs.kept.time(() => this.kept.drain());
  }

  async flushCatalog(): Promise<void> {
    await this.jobs.catalog.time(() => this.registry.flush());
  }

  /** Run one round of tier compaction (no-op if another process holds the lock). */
  async compact(now = Date.now()): Promise<CompactResult> {
    return this.jobs.compact.time(async () => {
      const r = await compactOnce(
        this.pool,
        { ...DEFAULT_COMPACT_OPTIONS, graceMinutes: this.opts.rollupGraceMinutes, flushMs: this.opts.rollupFlushMs },
        now,
      );
      const { watermarks: _w, ...rest } = r;
      this.lastCompact = rest;
      return r;
    });
  }

  /** Upsert service_last_state / edge_last_state for everything with live traffic. */
  async writeLastState(now = Date.now()): Promise<void> {
    await this.jobs.lastState.time(async () => {
      const at = new Date(now).toISOString();
      const svc = this.liveServices(now);
      if (svc.entries.size) {
        const cols = { id: [] as string[], rps: [] as number[], p50: [] as (number | null)[], p95: [] as (number | null)[], p99: [] as (number | null)[], err: [] as number[] };
        for (const [id, a] of svc.entries) {
          const s = summarize(a, svc.seconds);
          cols.id.push(id);
          cols.rps.push(s.rps);
          cols.p50.push(s.p50);
          cols.p95.push(s.p95);
          cols.p99.push(s.p99);
          cols.err.push(s.errPct);
        }
        await this.pool.query(
          `INSERT INTO service_last_state (service_id, at, rps, p50, p95, p99, err_pct)
           SELECT u.id, $1::timestamptz, u.rps, u.p50, u.p95, u.p99, u.err
           FROM unnest($2::text[], $3::float8[], $4::float8[], $5::float8[], $6::float8[], $7::float8[])
             AS u(id, rps, p50, p95, p99, err)
           ON CONFLICT (service_id) DO UPDATE SET at = EXCLUDED.at, rps = EXCLUDED.rps, p50 = EXCLUDED.p50,
             p95 = EXCLUDED.p95, p99 = EXCLUDED.p99, err_pct = EXCLUDED.err_pct`,
          [at, cols.id, cols.rps, cols.p50, cols.p95, cols.p99, cols.err],
        );
      }
      const edges = this.liveEdges(now);
      if (edges.entries.size) {
        const cols = { s: [] as string[], t: [] as string[], rps: [] as number[], p50: [] as (number | null)[], p95: [] as (number | null)[], p99: [] as (number | null)[], err: [] as number[] };
        for (const [key, a] of edges.entries) {
          const [src, dst] = splitEdgeKey(key);
          const s = summarize(a, edges.seconds);
          cols.s.push(src);
          cols.t.push(dst);
          cols.rps.push(s.rps);
          cols.p50.push(s.p50);
          cols.p95.push(s.p95);
          cols.p99.push(s.p99);
          cols.err.push(s.errPct);
        }
        await this.pool.query(
          `INSERT INTO edge_last_state (source_id, target_id, at, rps, p50, p95, p99, err_pct)
           SELECT u.s, u.t, $1::timestamptz, u.rps, u.p50, u.p95, u.p99, u.err
           FROM unnest($2::text[], $3::text[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[])
             AS u(s, t, rps, p50, p95, p99, err)
           ON CONFLICT (source_id, target_id) DO UPDATE SET at = EXCLUDED.at, rps = EXCLUDED.rps, p50 = EXCLUDED.p50,
             p95 = EXCLUDED.p95, p99 = EXCLUDED.p99, err_pct = EXCLUDED.err_pct`,
          [at, cols.s, cols.t, cols.rps, cols.p50, cols.p95, cols.p99, cols.err],
        );
      }
    });
  }

  async heartbeat(): Promise<void> {
    if (this.collectorId == null) return;
    const id = this.collectorId;
    await this.jobs.heartbeat.time(() => this.pool.query('UPDATE collectors SET heartbeat_at = now() WHERE id = $1', [id]));
  }

  // ---- read surface ----

  /**
   * Per-service aggregates (request-handling spans) over the last
   * LIVE_WINDOW_MINUTES, from memory. `seconds` is the time the window covers
   * (never before collector start); rps = n / seconds. Includes the partial
   * current minute. Only this collector's traffic.
   */
  liveServices(now = Date.now()): LiveWindow<string> {
    return this.cells.liveServices(now);
  }

  /**
   * Per-edge aggregates (the caller's client spans) over the live window,
   * keyed edgeKey(source, target); split with splitEdgeKey().
   */
  liveEdges(now = Date.now()): LiveWindow<string> {
    return this.cells.liveEdges(now);
  }

  stats(now = Date.now()): PipelineStats {
    const cs = this.cells.counters;
    const rp = this.registry.pending;
    return {
      collectorId: this.collectorId,
      startedAt: new Date(this.startedAtMs).toISOString(),
      uptimeSec: Math.round((now - this.startedAtMs) / 1000),
      memory: memoryMB(),
      spans: {
        accepted: this.c.accepted,
        lastMinute: this.spansLastMinute(now),
        clampedPast: cs.clampedPast,
        clampedFuture: cs.clampedFuture,
      },
      requests: { ...this.c.req, inflight: this.inflight },
      overload: { eventLoopLagMs: round(this.lagMs), lastReason: this.c.lastReason },
      rollup: {
        minutesInMemory: this.cells.minuteCount,
        cells: this.cells.cellCount(),
        backlogMinutes: this.cells.backlogMinutes(now),
        rowsWritten: this.c.rowsWritten,
        flush: this.jobs.rollup.stats(),
      },
      edges: { ...this.edges.stats(), observations: this.c.edgeObservations },
      traces: this.traces.stats(now),
      kept: { ...this.kept.stats(), flush: this.jobs.kept.stats() },
      catalog: { pendingServices: rp.services, pendingEdges: rp.edges, flush: this.jobs.catalog.stats() },
      compaction: { lastResult: this.lastCompact, job: this.jobs.compact.stats() },
      lastState: this.jobs.lastState.stats(),
      heartbeat: this.jobs.heartbeat.stats(),
      lastError: this.lastError,
    };
  }

  /** True once shutdown() has begun. */
  get isStopping(): boolean {
    return this.stopping;
  }
}
