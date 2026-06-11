-- Deptrace initial schema (TimescaleDB)
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;

-- Teams double as "groups": services (internal or external) are assigned to
-- them, and the map can collapse a team's services into a single meganode.
CREATE TABLE teams (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE services (
  id           TEXT PRIMARY KEY,            -- canonical id (OTEL service.name or inferred peer id)
  display_name TEXT,                        -- user-facing override; falls back to id
  description  TEXT,
  type         TEXT NOT NULL DEFAULT 'service', -- service|bff|gateway|postgres|redis|kafka|elastic|s3|external
  team_id      INT REFERENCES teams(id) ON DELETE SET NULL,
  runtime      TEXT,
  region       TEXT,
  is_external  BOOLEAN NOT NULL DEFAULT FALSE,  -- inferred peer with no own telemetry
  slo_target   DOUBLE PRECISION NOT NULL DEFAULT 99.9,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Manual association: telemetry arriving under `alias` is recorded as `service_id`.
CREATE TABLE service_aliases (
  alias      TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Learned (or manually asserted) caller -> dependency relationships.
CREATE TABLE edges (
  source_id    TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  target_id    TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sample_count BIGINT NOT NULL DEFAULT 0,
  manual       BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (source_id, target_id)
);

-- Raw spans (30-day retention).
CREATE TABLE spans (
  time            TIMESTAMPTZ NOT NULL,     -- span start time
  trace_id        TEXT NOT NULL,
  span_id         TEXT NOT NULL,
  parent_span_id  TEXT,
  service_id      TEXT NOT NULL,
  peer_service_id TEXT,                     -- resolved callee for client/producer spans
  name            TEXT NOT NULL,
  kind            SMALLINT NOT NULL,        -- OTEL SpanKind: 0..5
  duration_ms     DOUBLE PRECISION NOT NULL,
  is_error        BOOLEAN NOT NULL DEFAULT FALSE,
  is_root         BOOLEAN NOT NULL DEFAULT FALSE,
  http_status     INT,
  attrs           JSONB
);
SELECT create_hypertable('spans', 'time', chunk_time_interval => INTERVAL '6 hours');
CREATE INDEX spans_trace_idx ON spans (trace_id, time DESC);
CREATE INDEX spans_service_idx ON spans (service_id, time DESC);
SELECT add_retention_policy('spans', INTERVAL '30 days');

-- One row per observed caller->dependency call, measured from the CALLER's
-- client span (edge metrics are the caller's view of the upstream dependency).
CREATE TABLE edge_events (
  time        TIMESTAMPTZ NOT NULL,
  source_id   TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  operation   TEXT,
  duration_ms DOUBLE PRECISION NOT NULL,
  is_error    BOOLEAN NOT NULL DEFAULT FALSE
);
SELECT create_hypertable('edge_events', 'time', chunk_time_interval => INTERVAL '6 hours');
CREATE INDEX edge_events_pair_idx ON edge_events (source_id, target_id, time DESC);
CREATE INDEX edge_events_target_idx ON edge_events (target_id, time DESC);
SELECT add_retention_policy('edge_events', INTERVAL '30 days');

-- OTLP metrics (gauge/sum/histogram datapoints), stored for completeness.
CREATE TABLE metric_points (
  time       TIMESTAMPTZ NOT NULL,
  service_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,                 -- gauge|sum|histogram
  value      DOUBLE PRECISION,              -- point value / histogram sum
  count      BIGINT,                        -- histogram count
  attrs      JSONB
);
SELECT create_hypertable('metric_points', 'time', chunk_time_interval => INTERVAL '6 hours');
CREATE INDEX metric_points_svc_idx ON metric_points (service_id, name, time DESC);
SELECT add_retention_policy('metric_points', INTERVAL '30 days');

-- Per-minute request metrics by service and operation. Request-handling spans
-- are SERVER (2), CONSUMER (5), or trace roots.
CREATE MATERIALIZED VIEW service_op_metrics_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket('1 minute', time) AS bucket,
  service_id,
  name AS operation,
  count(*)::BIGINT AS span_count,
  (count(*) FILTER (WHERE is_error))::BIGINT AS error_count,
  percentile_agg(duration_ms) AS lat_agg
FROM spans
WHERE kind IN (2, 5) OR is_root
GROUP BY 1, 2, 3
WITH NO DATA;
SELECT add_continuous_aggregate_policy('service_op_metrics_1m',
  start_offset => INTERVAL '1 hour', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');
SELECT add_retention_policy('service_op_metrics_1m', INTERVAL '31 days');

-- Per-minute edge metrics (caller's client-span measurements per dependency).
CREATE MATERIALIZED VIEW edge_metrics_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket('1 minute', time) AS bucket,
  source_id,
  target_id,
  count(*)::BIGINT AS call_count,
  (count(*) FILTER (WHERE is_error))::BIGINT AS error_count,
  percentile_agg(duration_ms) AS lat_agg
FROM edge_events
GROUP BY 1, 2, 3
WITH NO DATA;
SELECT add_continuous_aggregate_policy('edge_metrics_1m',
  start_offset => INTERVAL '1 hour', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');
SELECT add_retention_policy('edge_metrics_1m', INTERVAL '31 days');

-- Per-edge observed operation mix (for the edge inspector drawer).
CREATE MATERIALIZED VIEW edge_op_metrics_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket('1 minute', time) AS bucket,
  source_id,
  target_id,
  operation,
  count(*)::BIGINT AS call_count
FROM edge_events
GROUP BY 1, 2, 3, 4
WITH NO DATA;
SELECT add_continuous_aggregate_policy('edge_op_metrics_1m',
  start_offset => INTERVAL '1 hour', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');
SELECT add_retention_policy('edge_op_metrics_1m', INTERVAL '31 days');
