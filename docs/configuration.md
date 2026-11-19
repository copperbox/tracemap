# Configuration

## Server

The server reads its settings from environment variables. The source of truth is
`server/src/config.ts`.

| Env var (server)             | Default                                                | Purpose |
| ---------------------------- | ------------------------------------------------------ | ------- |
| `DATABASE_URL`               | `postgres://tracemap:tracemap@localhost:5433/tracemap` | TimescaleDB connection |
| `PORT`                       | `4000`                                                 | Query/management API |
| `OTLP_PORT`                  | `4318`                                                 | OTLP/HTTP collector |
| `INGEST_POOL_MAX`            | `6`                                                    | Database connections for the collector's writers |
| `READ_POOL_MAX`              | `10`                                                   | Database connections for API reads |
| `LIVE_WINDOW_MINUTES`        | `5`                                                    | "Current" window for map metrics |
| `SNAPSHOT_INTERVAL_MS`       | `2000`                                                 | How often the live snapshot is rebuilt and pushed |
| `ROLLUP_FLUSH_MS`            | `10000`                                                | How often open rollup cells are written |
| `ROLLUP_GRACE_MINUTES`       | `3`                                                    | Minutes a rollup cell stays open for late spans |
| `ROLLUP_MAX_BACKLOG_MINUTES` | `30`                                                   | Closed minutes allowed to wait for the database before ingest answers 429 |
| `COMPACT_INTERVAL_MS`        | `60000`                                                | How often tier compaction runs |
| `MAX_OPS_PER_SERVICE`        | `200`                                                  | Distinct operations per service per minute; the rest count as `(other)` |
| `MAX_ERROR_SIGS_PER_SERVICE` | `100`                                                  | Distinct error signatures per service per minute; the rest count as `(other)` |
| `EDGE_RESOLVE_TTL_MS`        | `30000`                                                | How long an unpaired client or server span waits for its other half |
| `EDGE_RESOLVE_MAX_PENDING`   | `500000`                                               | Cap on unpaired spans held; the oldest are evicted first |
| `TRACE_DECISION_WAIT_MS`     | `10000`                                                | Decide a trace after this long without new spans |
| `TRACE_MAX_AGE_MS`           | `30000`                                                | Decide a trace at the latest this long after its first span |
| `TRACE_BUFFER_MAX_SPANS`     | `1000000`                                              | Spans held for undecided traces; past it, new traces cannot be kept |
| `TRACE_MAX_SPANS_PER_TRACE`  | `2000`                                                 | Spans held per trace |
| `KEPT_SPANS_PER_SEC`         | `1000`                                                 | Kept-trace budget, spans/s (one minute of burst) |
| `KEEP_ERROR_QUOTA`           | `3`                                                    | Error keeps per error signature per minute |
| `KEEP_SLOW_QUOTA`            | `2`                                                    | Slow keeps per root operation per minute |
| `KEEP_BASELINE_QUOTA`        | `1`                                                    | Baseline keeps per root operation per minute |
| `KEEP_BASELINE_SHARE`        | `0.25`                                                 | Share of the budget reserved for baseline keeps |
| `KEPT_QUEUE_MAX_SPANS`       | `200000`                                               | Kept spans queued for the writer before keeps are dropped |
| `OVERLOAD_LAG_MS`            | `1000`                                                 | Event-loop delay above which ingest answers 429 |
| `OVERLOAD_MAX_INFLIGHT`      | `512`                                                  | Concurrent OTLP requests above which ingest answers 429 |

The web dev server and `vite preview` read one variable, `API_PROXY_TARGET`, the
address of the query API. It defaults to `http://127.0.0.1:4000`.

## Demo simulator

`npm run simulate` replays a 40-service e-commerce topology, with an incident
story, as real OTLP/JSON exports.

```sh
npm run simulate -- --otlp http://127.0.0.1:4318 --api http://127.0.0.1:4000 --tps 6
```

While it runs in a terminal you can change the trace rate: `+` doubles it, `-`
halves it, clamped to 0.25 to 96 traces/s. `0`, space or `p` pauses and resumes.
`q` quits.

The simulator can grow the topology past the 40-service demo. The demo stays as
the core, and synthetic teams and services are added around it.

| Flag           | Env             | Default | Purpose                                                                 |
| -------------- | --------------- | ------- | ----------------------------------------------------------------------- |
| `--services`   | `SIM_SERVICES`  | `0`     | Target total node count; augments the demo with synthetic teams to reach it (0 = demo only). |
| `--teams`      | `SIM_TEAMS`     | `0`     | Number of synthetic teams to spread the generated services across (0 = derive from count). |
| `--unassigned` | `SIM_UNASSIGNED`| `0`     | Number of team-less inferred peers to mint (never seeded -- they stay unassigned). |
| `--dup-ratio`  | `SIM_DUP_RATIO` | `0.4`   | Fraction of unassigned peers minted as duplicate pairs: two names for one backend, to test merging. |

Synthetic teams own different numbers of services, so the map shows realistic size
differences. The unassigned duplicate pairs are two inferred nodes that stand for
one backend, for example `billing-2.example.com` and `api.billing-2.io`, or
`media-cdn-1-db` and `pg-media-cdn-1`. Merge them in the UI or with
`POST /api/services/:id/merge` to try out merging.

```sh
npm run simulate -- --services 300 --unassigned 40 --dup-ratio 0.5 --tps 24
```

For load at thousands of services, with seeded history, use the
[scale harness](scale-harness.md) instead.
