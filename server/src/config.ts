function num(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

/** Like num(), but zero or negative also falls back to the default. */
function positive(name: string, dflt: number): number {
  const n = num(name, dflt);
  return n > 0 ? n : dflt;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://tracemap:tracemap@localhost:5433/tracemap',
  /** Query/UI API port. */
  port: num('PORT', 4000),
  /** OTLP/HTTP collector port (standard OTLP/HTTP port is 4318). */
  otlpPort: num('OTLP_PORT', 4318),
  /** Window considered "current" for live map metrics, minutes. */
  liveWindowMinutes: num('LIVE_WINDOW_MINUTES', 5),
  /** How often the live snapshot (and its frame) is rebuilt, ms. */
  snapshotIntervalMs: positive('SNAPSHOT_INTERVAL_MS', 2000),
  retentionDays: 30,

  // ---- database pools ----
  /** Connections for the collector's background writers. */
  ingestPoolMax: num('INGEST_POOL_MAX', 6),
  /** Connections for API reads. */
  readPoolMax: num('READ_POOL_MAX', 10),

  // ---- rollups ----
  /** Minutes (including the current one) whose cells stay open and are rewritten each flush. */
  rollupGraceMinutes: num('ROLLUP_GRACE_MINUTES', 3),
  /** How often changed rollup cells are upserted, ms. */
  rollupFlushMs: num('ROLLUP_FLUSH_MS', 10_000),
  /** Closed minutes allowed to wait for the database before ingest answers 429. */
  rollupMaxBacklogMinutes: num('ROLLUP_MAX_BACKLOG_MINUTES', 30),
  /** Distinct operations per service (and per edge) per minute; the rest count as "(other)". */
  maxOpsPerService: num('MAX_OPS_PER_SERVICE', 200),
  /** Distinct error signatures per service (and per edge) per minute; the rest count as "(other)". */
  maxErrorSigsPerService: num('MAX_ERROR_SIGS_PER_SERVICE', 100),
  /** How often tier compaction runs, ms. */
  compactIntervalMs: num('COMPACT_INTERVAL_MS', 60_000),
  /** How often service_last_state / edge_last_state are upserted, ms. */
  lastStateMs: num('LAST_STATE_MS', 30_000),
  /** How often the collectors row is heartbeated, ms. */
  heartbeatMs: num('HEARTBEAT_MS', 10_000),
  /** How often new services, last_seen and learned edges are written, ms. */
  catalogFlushMs: num('CATALOG_FLUSH_MS', 5_000),

  // ---- edge pairing ----
  /** How long an unpaired client or server span waits for its other half, ms. */
  edgeResolveTtlMs: num('EDGE_RESOLVE_TTL_MS', 30_000),
  /** Hard cap on held unpaired spans; oldest are evicted first. */
  edgeResolveMaxPending: num('EDGE_RESOLVE_MAX_PENDING', 500_000),
  /** Slots per generation of the resolved-span id memory (8 bytes each, two generations). */
  edgeResolvedCapacity: num('EDGE_RESOLVED_CAPACITY', 1 << 21),

  // ---- trace curation ----
  /** Decide a trace after this long without new spans, ms. */
  traceDecisionWaitMs: num('TRACE_DECISION_WAIT_MS', 10_000),
  /** Decide a trace at the latest this long after its first span, ms. */
  traceMaxAgeMs: num('TRACE_MAX_AGE_MS', 30_000),
  /** Span bodies held for undecided traces. */
  traceBufferMaxSpans: num('TRACE_BUFFER_MAX_SPANS', 1_000_000),
  /** Span bodies held per trace. */
  traceMaxSpansPerTrace: num('TRACE_MAX_SPANS_PER_TRACE', 2_000),
  /** Keeps per error signature per minute. */
  keepErrorQuota: num('KEEP_ERROR_QUOTA', 3),
  /** Slow keeps per root operation per minute. */
  keepSlowQuota: num('KEEP_SLOW_QUOTA', 2),
  /** Baseline keeps per root operation per minute. */
  keepBaselineQuota: num('KEEP_BASELINE_QUOTA', 1),
  /** Global kept-span budget, spans/s (one minute of burst). */
  keptSpansPerSec: num('KEPT_SPANS_PER_SEC', 1_000),
  /** Share of that budget (0..1) reserved for baseline keeps; error and slow keeps cannot spend it. */
  keepBaselineShare: num('KEEP_BASELINE_SHARE', 0.25),
  /** Budget tokens at start; 0 so a restart cannot grant a fresh burst. */
  keptBudgetInitialSpans: num('KEPT_BUDGET_INITIAL_SPANS', 0),
  /** Spans the kept-trace writer may queue before keeps are dropped. */
  keptQueueMaxSpans: num('KEPT_QUEUE_MAX_SPANS', 200_000),
  /** How long decided trace ids are remembered for late spans, ms. */
  traceDecidedTtlMs: num('TRACE_DECIDED_TTL_MS', 60_000),
  /** Slots per generation of the decided-trace id memory. */
  traceDecidedCapacity: num('TRACE_DECIDED_CAPACITY', 1 << 21),

  // ---- overload gate ----
  /** Event-loop delay above which ingest answers 429, ms. */
  overloadLagMs: num('OVERLOAD_LAG_MS', 1_000),
  /** Concurrent OTLP requests above which ingest answers 429. */
  overloadMaxInflight: num('OVERLOAD_MAX_INFLIGHT', 512),
};

export type Config = typeof config;
