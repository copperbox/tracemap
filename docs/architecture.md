# Architecture

```
 your services --OTLP/HTTP--> collector (:4318) --rollup rows, kept traces--> TimescaleDB
                                in-memory 1m cells,                          1m/10m/1h/1d rollup tiers
                                trace buffer, edge pairing                   kept_spans / kept_traces
                                      |
                                      v live window
 browser <--SSE notices-- web (React) <-- query API (:4000) <-- live snapshot + rollup reader
```

TraceMap does not store raw spans. The collector counts every span into rollups,
keeps a sample of whole traces, and discards the rest. That is what lets one
process take 20,000 spans/s and still answer every query in a few milliseconds.

## Server

`server/` is Node.js and TypeScript, one process with two ports.

### OTLP collector, `:4318`

Accepts `POST /v1/traces` and `POST /v1/metrics` as `application/x-protobuf`
(vendored opentelemetry-proto definitions) or `application/json`, per the
[OTLP spec](https://opentelemetry.io/docs/specs/otlp/). A request is decoded and
handed to the pipeline without waiting on the database. See [API](api.md) for the
response codes.

### Rollups

The collector counts every span into per-minute cells in memory, one per service,
operation, edge, edge operation and error signature. Each cell holds counts and a
latency histogram with buckets 10% wide. It writes the cells as rollup rows.

The cells of the last few minutes stay open and are rewritten on each flush, so
late spans still count. Compaction then builds coarser tiers: `10m` from `1m`,
`1h` from `10m`, `1d` from `1h`. One process compacts at a time, under a Postgres
advisory lock.

| Tier | Kept for |
| --- | --- |
| `1m` | 3 days |
| `10m` | 30 days |
| `1h` | 395 days |
| `1d` | forever |

### Trace curation

Spans are buffered per trace until the trace has been quiet for 10 s, or is 30 s
old. Then the collector keeps the trace or drops it. It keeps:

- Errors: a few per error signature per minute.
- Slow traces: root duration at or above the p99 of its root operation.
- A baseline: one per root operation per minute.

All keeps share a budget of kept spans per second (`KEPT_SPANS_PER_SEC`), with a
share reserved for the baseline. Kept traces are stored for 30 days. Everything
else is counted in the rollups and discarded.

### Topology inference

The collector learns cross-service edges by joining CLIENT spans to the SERVER
spans they cause. This works whatever order the batches arrive in.

Databases, queues and external APIs never emit telemetry of their own. The
collector infers them from semantic-convention attributes such as `db.system`,
`messaging.system`, `peer.service`, `server.address` and `url.full`.

Edge metrics are always the caller's measurements of the dependency.

### Live snapshot

Every 2 s the server builds one snapshot of the whole map in memory. It combines
the collector's live window with the last known state of services that have no
current traffic, and every viewer shares it. The browser subscribes to
`/api/live` and fetches the map structure and a compact binary metrics frame when
they change.

### Query API, `:4000`

Live numbers come from the snapshot. History comes from the rollup tiers: the
reader picks the coarsest tier that fits the requested range and stitches in finer
tiers for the recent part. The API reads no raw spans. It also serves kept traces,
teams, and the curation endpoints for renames, merges and manual edges.

Merging two services touches only the catalog. History recorded under the old
name is found at read time through an alias, so a merge or unmerge costs the same
at any data size.

## Web

`web/` is React, Vite and zustand, with component styles in CSS modules.

The map uses a layered layout, with leaf dependencies at the top and the gateway
at the bottom. It draws frames, edges and overview nodes on a canvas, and mounts
DOM cards only for the nodes on screen at a readable zoom. Hover and selection
highlights go to a second canvas, so moving the pointer never redraws the map.
Long lists render only their visible rows.

The current view is reflected in the URL. See
[deep links](features.md#deep-links).

## Database

TimescaleDB on PostgreSQL 16. The rollup tiers and kept traces are compressed
hypertables with retention policies. The `1d` tier is a plain table, and so are
the service catalog, teams, edges, aliases and merges.

## Running more than one collector

Each collector process pairs edges and decides traces on its own, so every span of
a trace must reach the same process. Put a load balancer in front that routes by
trace id, for example the OpenTelemetry Collector's `loadbalancing` exporter with
`routing_key: traceID`. Each process writes its own `1m` rows, and readers sum
them.

Tests cover summing and compacting the rows of two collectors. Two collectors
have not yet been run end to end under load.

## Project layout

```
server/src/otlp/      OTLP decode (vendored protos), peer inference, service registry, ingest routes
server/src/pipeline/  rollup cells, edge pairing, trace buffer and curation, kept-trace writer
server/src/rollup/    tier metadata, histogram codec, tier compaction, rollup reader
server/src/live/      live snapshot, structure and binary metrics frame, SSE hub
server/src/api/       routes per resource (service list, detail, edit, merge, topology,
                      traces, errors, teams, series) and shared range parsing
server/src/db/        migrations (TimescaleDB schema), pools, legacy table drop
server/src/sim/       demo traffic generator, by stage (args, topology and procedural
                      augmentation, trace generation, OTLP encoding, http, metrics sampling)
server/src/sim/scale/ scale harness: synthetic fleet, history seed, OTLP load, API probe
web/src/state/        store, URL sync, live stream client
web/src/dev/          dev-only synthetic topology (?synthetic=N)
web/src/lib/          layout, team grouping, community detection, time ranges, formatters
web/src/theme/        global CSS variables and keyframes
web/src/features/     map (layered map, communities graph, render layers, drawer),
                      services list, service page, trace waterfall, wallboard
web/src/components/   top bar, charts, sparklines, SLO ring, icons
docs/                 feature guide, architecture, configuration, API, scale harness
```

Modules keep a narrow scope. Routes, simulator stages and UI sections are split
into small files. Shared design values are CSS variables in
`web/src/theme/global.css`, and only values computed at run time, such as
transforms and per-datum colors, stay inline.
