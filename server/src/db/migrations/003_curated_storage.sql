-- Curated storage: per-minute rollups built in the collector, compacted into
-- coarser tiers, plus a budgeted set of kept traces.
--
-- The legacy tables (spans, edge_events, metric_points) and their three
-- continuous aggregates stay in place, unread and unwritten. Drop them with
-- `npm run legacy:drop --workspace server -- --yes` once you no longer need them.
--
-- Tier and table metadata (names, grains, retention) is mirrored in
-- server/src/rollup/tiers.ts; keep the two in step.

-- One row per collector process start. A restart gets a new id, so a process
-- only ever overwrites 1m rows it owns.
CREATE TABLE collectors (
  id           SERIAL PRIMARY KEY,
  host         TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Compaction watermark per kind and target tier: every bucket of that tier
-- starting before compacted_through has been built from the tier below.
CREATE TABLE rollup_tier_state (
  kind              TEXT NOT NULL,
  tier              TEXT NOT NULL,
  compacted_through TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (kind, tier)
);

-- Rollup tiers. Each kind exists at 1m (per collector), 10m, 1h and 1d.
-- n/err are span counts, sum_ms is summed duration in ms, hist is the sparse
-- log histogram from server/src/rollup/hist.ts. 1m/10m/1h are compressed
-- hypertables with retention; 1d is a plain table kept forever.

-- svc_rollup
CREATE TABLE svc_rollup_1m (
  bucket TIMESTAMPTZ NOT NULL,
  collector_id INT NOT NULL,
  service_id TEXT NOT NULL,
  n BIGINT NOT NULL,
  err BIGINT NOT NULL,
  sum_ms DOUBLE PRECISION NOT NULL,
  hist BYTEA NOT NULL,
  PRIMARY KEY (bucket, collector_id, service_id)
);
SELECT create_hypertable('svc_rollup_1m', 'bucket', chunk_time_interval => INTERVAL '6 hours');
ALTER TABLE svc_rollup_1m SET (timescaledb.compress, timescaledb.compress_segmentby = 'service_id', timescaledb.compress_orderby = 'collector_id, bucket');
SELECT add_compression_policy('svc_rollup_1m', INTERVAL '1 day');
SELECT add_retention_policy('svc_rollup_1m', INTERVAL '3 days');
CREATE INDEX svc_rollup_1m_service_id_idx ON svc_rollup_1m (service_id, bucket DESC);
CREATE TABLE svc_rollup_10m (
  bucket TIMESTAMPTZ NOT NULL,
  service_id TEXT NOT NULL,
  n BIGINT NOT NULL,
  err BIGINT NOT NULL,
  sum_ms DOUBLE PRECISION NOT NULL,
  hist BYTEA NOT NULL,
  PRIMARY KEY (bucket, service_id)
);
SELECT create_hypertable('svc_rollup_10m', 'bucket', chunk_time_interval => INTERVAL '3 days');
ALTER TABLE svc_rollup_10m SET (timescaledb.compress, timescaledb.compress_segmentby = 'service_id', timescaledb.compress_orderby = 'bucket');
SELECT add_compression_policy('svc_rollup_10m', INTERVAL '3 days');
SELECT add_retention_policy('svc_rollup_10m', INTERVAL '30 days');
CREATE INDEX svc_rollup_10m_service_id_idx ON svc_rollup_10m (service_id, bucket DESC);
CREATE TABLE svc_rollup_1h (
  bucket TIMESTAMPTZ NOT NULL,
  service_id TEXT NOT NULL,
  n BIGINT NOT NULL,
  err BIGINT NOT NULL,
  sum_ms DOUBLE PRECISION NOT NULL,
  hist BYTEA NOT NULL,
  PRIMARY KEY (bucket, service_id)
);
SELECT create_hypertable('svc_rollup_1h', 'bucket', chunk_time_interval => INTERVAL '30 days');
ALTER TABLE svc_rollup_1h SET (timescaledb.compress, timescaledb.compress_segmentby = 'service_id', timescaledb.compress_orderby = 'bucket');
SELECT add_compression_policy('svc_rollup_1h', INTERVAL '30 days');
SELECT add_retention_policy('svc_rollup_1h', INTERVAL '395 days');
CREATE INDEX svc_rollup_1h_service_id_idx ON svc_rollup_1h (service_id, bucket DESC);
CREATE TABLE svc_rollup_1d (
  bucket TIMESTAMPTZ NOT NULL,
  service_id TEXT NOT NULL,
  n BIGINT NOT NULL,
  err BIGINT NOT NULL,
  sum_ms DOUBLE PRECISION NOT NULL,
  hist BYTEA NOT NULL,
  PRIMARY KEY (bucket, service_id)
);
CREATE INDEX svc_rollup_1d_service_id_idx ON svc_rollup_1d (service_id, bucket DESC);

-- op_rollup
CREATE TABLE op_rollup_1m (
  bucket TIMESTAMPTZ NOT NULL,
  collector_id INT NOT NULL,
  service_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  n BIGINT NOT NULL,
  err BIGINT NOT NULL,
  sum_ms DOUBLE PRECISION NOT NULL,
  hist BYTEA NOT NULL,
  PRIMARY KEY (bucket, collector_id, service_id, operation)
);
SELECT create_hypertable('op_rollup_1m', 'bucket', chunk_time_interval => INTERVAL '6 hours');
ALTER TABLE op_rollup_1m SET (timescaledb.compress, timescaledb.compress_segmentby = 'service_id', timescaledb.compress_orderby = 'collector_id, operation, bucket');
SELECT add_compression_policy('op_rollup_1m', INTERVAL '1 day');
SELECT add_retention_policy('op_rollup_1m', INTERVAL '3 days');
CREATE INDEX op_rollup_1m_service_id_idx ON op_rollup_1m (service_id, bucket DESC);
CREATE TABLE op_rollup_10m (
  bucket TIMESTAMPTZ NOT NULL,
  service_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  n BIGINT NOT NULL,
  err BIGINT NOT NULL,
  sum_ms DOUBLE PRECISION NOT NULL,
  hist BYTEA NOT NULL,
  PRIMARY KEY (bucket, service_id, operation)
);
SELECT create_hypertable('op_rollup_10m', 'bucket', chunk_time_interval => INTERVAL '3 days');
ALTER TABLE op_rollup_10m SET (timescaledb.compress, timescaledb.compress_segmentby = 'service_id', timescaledb.compress_orderby = 'operation, bucket');
SELECT add_compression_policy('op_rollup_10m', INTERVAL '3 days');
SELECT add_retention_policy('op_rollup_10m', INTERVAL '30 days');
CREATE INDEX op_rollup_10m_service_id_idx ON op_rollup_10m (service_id, bucket DESC);
CREATE TABLE op_rollup_1h (
  bucket TIMESTAMPTZ NOT NULL,
  service_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  n BIGINT NOT NULL,
  err BIGINT NOT NULL,
  sum_ms DOUBLE PRECISION NOT NULL,
  hist BYTEA NOT NULL,
  PRIMARY KEY (bucket, service_id, operation)
);
SELECT create_hypertable('op_rollup_1h', 'bucket', chunk_time_interval => INTERVAL '30 days');
ALTER TABLE op_rollup_1h SET (timescaledb.compress, timescaledb.compress_segmentby = 'service_id', timescaledb.compress_orderby = 'operation, bucket');
SELECT add_compression_policy('op_rollup_1h', INTERVAL '30 days');
SELECT add_retention_policy('op_rollup_1h', INTERVAL '395 days');
CREATE INDEX op_rollup_1h_service_id_idx ON op_rollup_1h (service_id, bucket DESC);
CREATE TABLE op_rollup_1d (
  bucket TIMESTAMPTZ NOT NULL,
  service_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  n BIGINT NOT NULL,
  err BIGINT NOT NULL,
  sum_ms DOUBLE PRECISION NOT NULL,
  hist BYTEA NOT NULL,
  PRIMARY KEY (bucket, service_id, operation)
);
CREATE INDEX op_rollup_1d_service_id_idx ON op_rollup_1d (service_id, bucket DESC);

-- edge_rollup
CREATE TABLE edge_rollup_1m (
  bucket TIMESTAMPTZ NOT NULL,
  collector_id INT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  n BIGINT NOT NULL,
  err BIGINT NOT NULL,
  sum_ms DOUBLE PRECISION NOT NULL,
  hist BYTEA NOT NULL,
  PRIMARY KEY (bucket, collector_id, source_id, target_id)
);
SELECT create_hypertable('edge_rollup_1m', 'bucket', chunk_time_interval => INTERVAL '6 hours');
ALTER TABLE edge_rollup_1m SET (timescaledb.compress, timescaledb.compress_segmentby = 'source_id', timescaledb.compress_orderby = 'collector_id, target_id, bucket');
SELECT add_compression_policy('edge_rollup_1m', INTERVAL '1 day');
SELECT add_retention_policy('edge_rollup_1m', INTERVAL '3 days');
CREATE INDEX edge_rollup_1m_source_id_idx ON edge_rollup_1m (source_id, bucket DESC);
CREATE INDEX edge_rollup_1m_target_id_idx ON edge_rollup_1m (target_id, bucket DESC);
CREATE TABLE edge_rollup_10m (
  bucket TIMESTAMPTZ NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  n BIGINT NOT NULL,
  err BIGINT NOT NULL,
  sum_ms DOUBLE PRECISION NOT NULL,
  hist BYTEA NOT NULL,
  PRIMARY KEY (bucket, source_id, target_id)
);
SELECT create_hypertable('edge_rollup_10m', 'bucket', chunk_time_interval => INTERVAL '3 days');
ALTER TABLE edge_rollup_10m SET (timescaledb.compress, timescaledb.compress_segmentby = 'source_id', timescaledb.compress_orderby = 'target_id, bucket');
SELECT add_compression_policy('edge_rollup_10m', INTERVAL '3 days');
SELECT add_retention_policy('edge_rollup_10m', INTERVAL '30 days');
CREATE INDEX edge_rollup_10m_source_id_idx ON edge_rollup_10m (source_id, bucket DESC);
CREATE INDEX edge_rollup_10m_target_id_idx ON edge_rollup_10m (target_id, bucket DESC);
CREATE TABLE edge_rollup_1h (
  bucket TIMESTAMPTZ NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  n BIGINT NOT NULL,
  err BIGINT NOT NULL,
  sum_ms DOUBLE PRECISION NOT NULL,
  hist BYTEA NOT NULL,
  PRIMARY KEY (bucket, source_id, target_id)
);
SELECT create_hypertable('edge_rollup_1h', 'bucket', chunk_time_interval => INTERVAL '30 days');
ALTER TABLE edge_rollup_1h SET (timescaledb.compress, timescaledb.compress_segmentby = 'source_id', timescaledb.compress_orderby = 'target_id, bucket');
SELECT add_compression_policy('edge_rollup_1h', INTERVAL '30 days');
SELECT add_retention_policy('edge_rollup_1h', INTERVAL '395 days');
CREATE INDEX edge_rollup_1h_source_id_idx ON edge_rollup_1h (source_id, bucket DESC);
CREATE INDEX edge_rollup_1h_target_id_idx ON edge_rollup_1h (target_id, bucket DESC);
CREATE TABLE edge_rollup_1d (
  bucket TIMESTAMPTZ NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  n BIGINT NOT NULL,
  err BIGINT NOT NULL,
  sum_ms DOUBLE PRECISION NOT NULL,
  hist BYTEA NOT NULL,
  PRIMARY KEY (bucket, source_id, target_id)
);
CREATE INDEX edge_rollup_1d_source_id_idx ON edge_rollup_1d (source_id, bucket DESC);
CREATE INDEX edge_rollup_1d_target_id_idx ON edge_rollup_1d (target_id, bucket DESC);

-- edge_op_rollup
CREATE TABLE edge_op_rollup_1m (
  bucket TIMESTAMPTZ NOT NULL,
  collector_id INT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  n BIGINT NOT NULL,
  err BIGINT NOT NULL,
  PRIMARY KEY (bucket, collector_id, source_id, target_id, operation)
);
SELECT create_hypertable('edge_op_rollup_1m', 'bucket', chunk_time_interval => INTERVAL '6 hours');
ALTER TABLE edge_op_rollup_1m SET (timescaledb.compress, timescaledb.compress_segmentby = 'source_id', timescaledb.compress_orderby = 'collector_id, target_id, operation, bucket');
SELECT add_compression_policy('edge_op_rollup_1m', INTERVAL '1 day');
SELECT add_retention_policy('edge_op_rollup_1m', INTERVAL '3 days');
CREATE INDEX edge_op_rollup_1m_source_id_idx ON edge_op_rollup_1m (source_id, bucket DESC);
CREATE INDEX edge_op_rollup_1m_target_id_idx ON edge_op_rollup_1m (target_id, bucket DESC);
CREATE TABLE edge_op_rollup_10m (
  bucket TIMESTAMPTZ NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  n BIGINT NOT NULL,
  err BIGINT NOT NULL,
  PRIMARY KEY (bucket, source_id, target_id, operation)
);
SELECT create_hypertable('edge_op_rollup_10m', 'bucket', chunk_time_interval => INTERVAL '3 days');
ALTER TABLE edge_op_rollup_10m SET (timescaledb.compress, timescaledb.compress_segmentby = 'source_id', timescaledb.compress_orderby = 'target_id, operation, bucket');
SELECT add_compression_policy('edge_op_rollup_10m', INTERVAL '3 days');
SELECT add_retention_policy('edge_op_rollup_10m', INTERVAL '30 days');
CREATE INDEX edge_op_rollup_10m_source_id_idx ON edge_op_rollup_10m (source_id, bucket DESC);
CREATE INDEX edge_op_rollup_10m_target_id_idx ON edge_op_rollup_10m (target_id, bucket DESC);
CREATE TABLE edge_op_rollup_1h (
  bucket TIMESTAMPTZ NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  n BIGINT NOT NULL,
  err BIGINT NOT NULL,
  PRIMARY KEY (bucket, source_id, target_id, operation)
);
SELECT create_hypertable('edge_op_rollup_1h', 'bucket', chunk_time_interval => INTERVAL '30 days');
ALTER TABLE edge_op_rollup_1h SET (timescaledb.compress, timescaledb.compress_segmentby = 'source_id', timescaledb.compress_orderby = 'target_id, operation, bucket');
SELECT add_compression_policy('edge_op_rollup_1h', INTERVAL '30 days');
SELECT add_retention_policy('edge_op_rollup_1h', INTERVAL '395 days');
CREATE INDEX edge_op_rollup_1h_source_id_idx ON edge_op_rollup_1h (source_id, bucket DESC);
CREATE INDEX edge_op_rollup_1h_target_id_idx ON edge_op_rollup_1h (target_id, bucket DESC);
CREATE TABLE edge_op_rollup_1d (
  bucket TIMESTAMPTZ NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  n BIGINT NOT NULL,
  err BIGINT NOT NULL,
  PRIMARY KEY (bucket, source_id, target_id, operation)
);
CREATE INDEX edge_op_rollup_1d_source_id_idx ON edge_op_rollup_1d (source_id, bucket DESC);
CREATE INDEX edge_op_rollup_1d_target_id_idx ON edge_op_rollup_1d (target_id, bucket DESC);

-- svc_error_rollup
CREATE TABLE svc_error_rollup_1m (
  bucket TIMESTAMPTZ NOT NULL,
  collector_id INT NOT NULL,
  service_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  n BIGINT NOT NULL,
  sample_trace_id UUID,
  PRIMARY KEY (bucket, collector_id, service_id, operation, code, message)
);
SELECT create_hypertable('svc_error_rollup_1m', 'bucket', chunk_time_interval => INTERVAL '6 hours');
ALTER TABLE svc_error_rollup_1m SET (timescaledb.compress, timescaledb.compress_segmentby = 'service_id', timescaledb.compress_orderby = 'collector_id, operation, code, message, bucket');
SELECT add_compression_policy('svc_error_rollup_1m', INTERVAL '1 day');
SELECT add_retention_policy('svc_error_rollup_1m', INTERVAL '3 days');
CREATE INDEX svc_error_rollup_1m_service_id_idx ON svc_error_rollup_1m (service_id, bucket DESC);
CREATE TABLE svc_error_rollup_10m (
  bucket TIMESTAMPTZ NOT NULL,
  service_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  n BIGINT NOT NULL,
  sample_trace_id UUID,
  PRIMARY KEY (bucket, service_id, operation, code, message)
);
SELECT create_hypertable('svc_error_rollup_10m', 'bucket', chunk_time_interval => INTERVAL '3 days');
ALTER TABLE svc_error_rollup_10m SET (timescaledb.compress, timescaledb.compress_segmentby = 'service_id', timescaledb.compress_orderby = 'operation, code, message, bucket');
SELECT add_compression_policy('svc_error_rollup_10m', INTERVAL '3 days');
SELECT add_retention_policy('svc_error_rollup_10m', INTERVAL '30 days');
CREATE INDEX svc_error_rollup_10m_service_id_idx ON svc_error_rollup_10m (service_id, bucket DESC);
CREATE TABLE svc_error_rollup_1h (
  bucket TIMESTAMPTZ NOT NULL,
  service_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  n BIGINT NOT NULL,
  sample_trace_id UUID,
  PRIMARY KEY (bucket, service_id, operation, code, message)
);
SELECT create_hypertable('svc_error_rollup_1h', 'bucket', chunk_time_interval => INTERVAL '30 days');
ALTER TABLE svc_error_rollup_1h SET (timescaledb.compress, timescaledb.compress_segmentby = 'service_id', timescaledb.compress_orderby = 'operation, code, message, bucket');
SELECT add_compression_policy('svc_error_rollup_1h', INTERVAL '30 days');
SELECT add_retention_policy('svc_error_rollup_1h', INTERVAL '395 days');
CREATE INDEX svc_error_rollup_1h_service_id_idx ON svc_error_rollup_1h (service_id, bucket DESC);
CREATE TABLE svc_error_rollup_1d (
  bucket TIMESTAMPTZ NOT NULL,
  service_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  n BIGINT NOT NULL,
  sample_trace_id UUID,
  PRIMARY KEY (bucket, service_id, operation, code, message)
);
CREATE INDEX svc_error_rollup_1d_service_id_idx ON svc_error_rollup_1d (service_id, bucket DESC);

-- edge_error_rollup
CREATE TABLE edge_error_rollup_1m (
  bucket TIMESTAMPTZ NOT NULL,
  collector_id INT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  n BIGINT NOT NULL,
  sample_trace_id UUID,
  PRIMARY KEY (bucket, collector_id, source_id, target_id, operation, code, message)
);
SELECT create_hypertable('edge_error_rollup_1m', 'bucket', chunk_time_interval => INTERVAL '6 hours');
ALTER TABLE edge_error_rollup_1m SET (timescaledb.compress, timescaledb.compress_segmentby = 'source_id', timescaledb.compress_orderby = 'collector_id, target_id, operation, code, message, bucket');
SELECT add_compression_policy('edge_error_rollup_1m', INTERVAL '1 day');
SELECT add_retention_policy('edge_error_rollup_1m', INTERVAL '3 days');
CREATE INDEX edge_error_rollup_1m_source_id_idx ON edge_error_rollup_1m (source_id, bucket DESC);
CREATE INDEX edge_error_rollup_1m_target_id_idx ON edge_error_rollup_1m (target_id, bucket DESC);
CREATE TABLE edge_error_rollup_10m (
  bucket TIMESTAMPTZ NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  n BIGINT NOT NULL,
  sample_trace_id UUID,
  PRIMARY KEY (bucket, source_id, target_id, operation, code, message)
);
SELECT create_hypertable('edge_error_rollup_10m', 'bucket', chunk_time_interval => INTERVAL '3 days');
ALTER TABLE edge_error_rollup_10m SET (timescaledb.compress, timescaledb.compress_segmentby = 'source_id', timescaledb.compress_orderby = 'target_id, operation, code, message, bucket');
SELECT add_compression_policy('edge_error_rollup_10m', INTERVAL '3 days');
SELECT add_retention_policy('edge_error_rollup_10m', INTERVAL '30 days');
CREATE INDEX edge_error_rollup_10m_source_id_idx ON edge_error_rollup_10m (source_id, bucket DESC);
CREATE INDEX edge_error_rollup_10m_target_id_idx ON edge_error_rollup_10m (target_id, bucket DESC);
CREATE TABLE edge_error_rollup_1h (
  bucket TIMESTAMPTZ NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  n BIGINT NOT NULL,
  sample_trace_id UUID,
  PRIMARY KEY (bucket, source_id, target_id, operation, code, message)
);
SELECT create_hypertable('edge_error_rollup_1h', 'bucket', chunk_time_interval => INTERVAL '30 days');
ALTER TABLE edge_error_rollup_1h SET (timescaledb.compress, timescaledb.compress_segmentby = 'source_id', timescaledb.compress_orderby = 'target_id, operation, code, message, bucket');
SELECT add_compression_policy('edge_error_rollup_1h', INTERVAL '30 days');
SELECT add_retention_policy('edge_error_rollup_1h', INTERVAL '395 days');
CREATE INDEX edge_error_rollup_1h_source_id_idx ON edge_error_rollup_1h (source_id, bucket DESC);
CREATE INDEX edge_error_rollup_1h_target_id_idx ON edge_error_rollup_1h (target_id, bucket DESC);
CREATE TABLE edge_error_rollup_1d (
  bucket TIMESTAMPTZ NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  n BIGINT NOT NULL,
  sample_trace_id UUID,
  PRIMARY KEY (bucket, source_id, target_id, operation, code, message)
);
CREATE INDEX edge_error_rollup_1d_source_id_idx ON edge_error_rollup_1d (source_id, bucket DESC);
CREATE INDEX edge_error_rollup_1d_target_id_idx ON edge_error_rollup_1d (target_id, bucket DESC);


-- Last known numbers per service and edge, so a restarted collector can show
-- entities that have no traffic right now (marked stale by the reader).
CREATE TABLE service_last_state (
  service_id TEXT PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL,
  rps        DOUBLE PRECISION NOT NULL,
  p50        DOUBLE PRECISION,
  p95        DOUBLE PRECISION,
  p99        DOUBLE PRECISION,
  err_pct    DOUBLE PRECISION NOT NULL
);

CREATE TABLE edge_last_state (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  at        TIMESTAMPTZ NOT NULL,
  rps       DOUBLE PRECISION NOT NULL,
  p50       DOUBLE PRECISION,
  p95       DOUBLE PRECISION,
  p99       DOUBLE PRECISION,
  err_pct   DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (source_id, target_id)
);

-- Kept traces: the sample the collector's curation chose (errors, slow,
-- baseline), under a global span budget. Span ids are the 16-hex id read as a
-- two's complement bigint; trace ids are the 32-hex id as uuid.
CREATE TABLE kept_spans (
  time            TIMESTAMPTZ NOT NULL,        -- span start
  trace_id        UUID NOT NULL,
  span_id         BIGINT NOT NULL,
  parent_span_id  BIGINT,
  service_id      TEXT NOT NULL,
  peer_service_id TEXT,                         -- resolved callee for client/producer spans
  name            TEXT NOT NULL,
  kind            SMALLINT NOT NULL,
  duration_ms     DOUBLE PRECISION NOT NULL,
  is_error        BOOLEAN NOT NULL,
  is_root         BOOLEAN NOT NULL,
  http_status     INT,
  attrs           JSONB
);
SELECT create_hypertable('kept_spans', 'time', chunk_time_interval => INTERVAL '2 hours');
CREATE INDEX kept_spans_trace_idx ON kept_spans (trace_id, time);
ALTER TABLE kept_spans SET (timescaledb.compress, timescaledb.compress_orderby = 'trace_id, time');
SELECT add_compression_policy('kept_spans', INTERVAL '2 hours');
SELECT add_retention_policy('kept_spans', INTERVAL '30 days');

-- One row per kept trace. A trace id finds its time range here, then reads
-- kept_spans within it.
CREATE TABLE kept_traces (
  time           TIMESTAMPTZ NOT NULL,         -- earliest span start
  trace_id       UUID NOT NULL,
  root_service   TEXT,
  root_operation TEXT,
  duration_ms    DOUBLE PRECISION NOT NULL,
  span_count     INT NOT NULL,
  has_error      BOOLEAN NOT NULL,
  reason         TEXT NOT NULL CHECK (reason IN ('error', 'slow', 'baseline'))
);
SELECT create_hypertable('kept_traces', 'time', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX kept_traces_trace_idx ON kept_traces (trace_id);
ALTER TABLE kept_traces SET (timescaledb.compress, timescaledb.compress_orderby = 'trace_id, time');
SELECT add_compression_policy('kept_traces', INTERVAL '2 days');
SELECT add_retention_policy('kept_traces', INTERVAL '30 days');

-- Which services each kept trace touched: backs "recent traces for this
-- service", optionally only those where one of error_ops failed.
CREATE TABLE kept_trace_services (
  time       TIMESTAMPTZ NOT NULL,
  service_id TEXT NOT NULL,
  trace_id   UUID NOT NULL,
  has_error  BOOLEAN NOT NULL,
  error_ops  TEXT[] NOT NULL DEFAULT '{}'
);
SELECT create_hypertable('kept_trace_services', 'time', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX kept_trace_services_svc_idx ON kept_trace_services (service_id, time DESC);
ALTER TABLE kept_trace_services SET (timescaledb.compress, timescaledb.compress_segmentby = 'service_id', timescaledb.compress_orderby = 'time DESC');
SELECT add_compression_policy('kept_trace_services', INTERVAL '2 days');
SELECT add_retention_policy('kept_trace_services', INTERVAL '30 days');
