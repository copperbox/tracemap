# Deptrace

Deptrace is an observability service for incident response. It acts as an OTLP
collector, learns your company's entire service topology from the traces and
metrics your services already emit, and renders it as a live interactive
dependency map -- so you can spot an incident at its *source* instead of
working backwards from symptoms team by team.

## What it does

- **Service map** - a live, pannable/zoomable graph of every known service
  (internal and external) and every learned caller -> dependency edge. Health
  is encoded as heat (green/amber/red) on node borders and edges. Edges show
  the direction of data flow: animated particles (speed tracks call rate)
  travel from each dependency down into the service that depends on it,
  ending in an arrowhead at the dependent's edge. Nodes can be
  dragged to custom positions (edges follow; positions persist locally and a
  reset-layout button restores the default layout). No date selection needed:
  the map always
  shows the current (or last-known) state of everything, even services with
  no recent traffic.
- **Team grouping (meganodes)** - services are assigned to owning teams.
  Toggle "Group by team" and each team collapses into a single meganode,
  turning hundreds of nodes into a clean "team depends on team" view. Any
  single meganode can be ungrouped back into its services (and regrouped)
  for selective deep dives. External dependencies stay individual until you
  manually assign them to a group. Grouping changes animate -- merged
  services visibly converge into their meganode, ungrouped services fly
  back out of it -- so it is always clear which nodes just merged or split.
- **Inspector drawer** - click any node, meganode, or edge to inspect SLO
  attainment + error budget, KPIs, 24h sparklines, callers/dependencies, and
  for edges: the learned relationship (first observed, supporting spans,
  confidence, auto vs manual source) and the observed operation mix.
- **Service pages** - per-service deep dive with KPI cards,
  latency/throughput/error-rate charts (crosshair hover tooltips), top
  operations, linked upstream/downstream services, and recent traces.
  A Kibana-style date/time picker (quick ranges or absolute from/to) scopes
  everything on the page.
- **Trace waterfall** - click a trace to open the full distributed span tree
  with timing bars and raw OTEL span attributes.
- **Manual curation** - rename services, set descriptions, owning team/group,
  type and SLO target; manually associate dependencies the inference cannot
  see; and merge duplicate services (same service reported under different
  names) into one canonical service -- historical telemetry is re-pointed and
  the old name becomes an alias for all future traffic.

## Architecture

```
 your services --OTLP/HTTP--> server (Fastify, :4318)  --> TimescaleDB
                                  |                          spans + edge_events hypertables
                                  |                          continuous aggregates (1m)
                                  |                          30-day retention policies
 browser <----- web (React) <-- query API (:4000)
```

- `server/` - Node.js + TypeScript.
  - **OTLP collector** (`:4318`): accepts `POST /v1/traces` and
    `POST /v1/metrics` in both `application/x-protobuf` (vendored
    opentelemetry-proto definitions) and `application/json`, per the
    [OTLP spec](https://opentelemetry.io/docs/specs/otlp/).
  - **Topology inference**: cross-service edges are learned by joining CLIENT
    spans to the SERVER spans they cause (works regardless of batch arrival
    order); databases, queues, and external APIs that never emit telemetry are
    inferred from semantic-convention attributes (`db.system`,
    `messaging.system`, `peer.service`, `server.address`, `url.full`, ...).
    Edge metrics are always the *caller's* measurements of the dependency.
  - **Query API** (`:4000`): topology, service list/detail, time series,
    traces, teams, and the curation endpoints (rename/merge/manual edges).
- `web/` - React + Vite + zustand. Custom SVG map (layered DAG layout - leaf
  dependencies on top, gateway at the bottom), charts, and the full UI from
  the design handoff (dark/light themes, green accent).
- **TimescaleDB** (Postgres + timescaledb_toolkit): raw `spans` and
  `edge_events` hypertables with per-minute continuous aggregates
  (`percentile_agg` sketches for p50/p95/p99) powering all charts, and
  automatic **30-day retention** on all telemetry.

## Quick start

Requires Docker (and Node 22+ for local dev).

```sh
# Everything in containers (db + collector/API + web on :5173)
docker compose up -d --build

# Or: database in Docker, apps locally (best for development)
docker compose up -d db
npm install
npm run migrate          # apply schema to the db
npm run dev              # server (:4000 api, :4318 otlp) + web (:5173)

# Optional: demo traffic - replays a 40-service e-commerce topology
# (with a live incident narrative) as real OTLP/JSON exports
npm run simulate
```

Open http://localhost:5173. Point real services at
`http://<host>:4318/v1/traces` (standard OTLP/HTTP exporter settings).

## Configuration

| Env var (server)       | Default                                                 | Purpose                          |
| ---------------------- | ------------------------------------------------------- | -------------------------------- |
| `DATABASE_URL`         | `postgres://deptrace:deptrace@localhost:5433/deptrace`  | TimescaleDB connection           |
| `PORT`                 | `4000`                                                  | Query/management API             |
| `OTLP_PORT`            | `4318`                                                  | OTLP/HTTP collector              |
| `EDGE_RESOLVE_TTL_MS`  | `90000`                                                 | Cross-batch span join window     |
| `LIVE_WINDOW_MINUTES`  | `5`                                                     | "Current" window for map metrics |

Simulator flags: `npm run simulate -- --otlp http://127.0.0.1:4318 --api http://127.0.0.1:4000 --tps 6`.

## API overview

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/traces`, `POST /v1/metrics` (`:4318`) | OTLP/HTTP ingest (protobuf + JSON) |
| `GET /api/topology` | Full live map: services, edges, teams, current metrics |
| `GET /api/services` | Service list with sparklines + SLO |
| `GET /api/services/:id?from=&to=` | Detail: KPIs, series, operations, neighbors |
| `GET /api/services/:id/traces?from=&to=` | Recent traces touching a service |
| `GET /api/traces/:traceId` | Full trace for the waterfall |
| `PATCH /api/services/:id` | Rename / describe / team / type / SLO target |
| `POST /api/services/:id/merge` | Merge a duplicate service into this one (aliases its name) |
| `POST/DELETE /api/services/:id/dependencies` | Manual dependency association |
| `GET/POST /api/teams` | Team (group) management |
| `GET /api/health` | Ingest liveness + counters |

## Testing

```sh
npm test          # server (OTLP decode, peer inference, edge resolver) + web (layout, grouping, formatters)
```

## Project layout

```
server/src/otlp/      OTLP decode (vendored protos), peer inference, edge resolver, ingest
server/src/api/       topology / services / traces / teams / series routes
server/src/db/        migrations (TimescaleDB schema), pool
server/src/sim/       demo traffic generator
web/src/lib/          DAG layout, team grouping, time ranges, formatters
web/src/features/     map (canvas, node cards, drawer), services list, service page, trace waterfall
web/src/components/   top bar, charts, sparklines, SLO ring, icons
```

## Notes & limitations

- Merging services rewrites historical rows and refreshes the aggregates;
  on very large datasets this is a heavyweight admin operation.
- Deleting a *learned* edge removes it until new telemetry re-learns it;
  deleting a *manual* edge is permanent.
- OTLP/gRPC (`:4317`) is not implemented; use OTLP/HTTP (`:4318`), which every
  OTEL SDK and collector supports.
