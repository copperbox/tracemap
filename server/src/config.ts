export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://deptrace:deptrace@localhost:5433/deptrace',
  /** Query/UI API port. */
  port: Number(process.env.PORT ?? 4000),
  /** OTLP/HTTP collector port (standard OTLP/HTTP port is 4318). */
  otlpPort: Number(process.env.OTLP_PORT ?? 4318),
  /** How long unmatched client/server spans are held for cross-service edge resolution. */
  edgeResolveTtlMs: Number(process.env.EDGE_RESOLVE_TTL_MS ?? 90_000),
  /** Window considered "current" for live map metrics. */
  liveWindowMinutes: Number(process.env.LIVE_WINDOW_MINUTES ?? 5),
  retentionDays: 30,
};
