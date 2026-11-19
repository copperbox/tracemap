# API

The collector listens on `:4318` and the query API on `:4000`. Neither has
authentication. See [security](../README.md#security).

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/traces`, `POST /v1/metrics` (`:4318`) | OTLP/HTTP ingest (protobuf + JSON) |
| `GET /api/live` | Server-sent events: `hello`, then a `structure` notice when the map structure changes and a `metrics` notice for each new snapshot |
| `GET /api/live/structure` | Services, edges and teams of the live snapshot (JSON, `ETag` = structure version) |
| `GET /api/live/metrics` | Latest metrics frame: rps, p50, p95, p99, error % and status per service and edge (binary) |
| `GET /api/topology` | Full live map: services, edges, teams, current metrics (JSON, from the same snapshot) |
| `GET /api/services` | Service list with sparklines + SLO |
| `GET /api/services/:id?from=&to=` | Detail: KPIs, series, operations, neighbors |
| `GET /api/services/:id/sparklines` | 24 hourly points of p95, throughput and error rate |
| `GET /api/edges/:source/:target/series` | 24 hourly points of an edge's latency and calls, plus its operation mix |
| `GET /api/services/:id/traces?from=&to=&op=` | Recent kept traces touching a service, each with the reason it was kept (`op` filters to that operation's failures) |
| `GET /api/services/:id/errors?from=&to=` | Top erroring operations + the errors seen, exact counts from the error-signature rollups, with a `sampleTraceId` when a trace was kept |
| `GET /api/edges/:source/:target/errors` | The same for one edge |
| `GET /api/traces/:traceId` | Full kept trace for the waterfall |
| `PATCH /api/services/:id` | Rename / describe / team / type / SLO target |
| `POST /api/services/:id/merge` | Merge a duplicate service into this one (aliases its name) |
| `POST /api/services/:id/unmerge` | Reverse a merge, splitting a duplicate back into its own service |
| `POST/DELETE /api/services/:id/dependencies` | Manual dependency association |
| `GET/POST /api/teams` | Team (group) management |
| `GET /api/health` | Ingest liveness + pipeline counters (accepted, rejected, kept and dropped traces, queue depths, flush times) |

## Ingest responses

The collector decodes a request and hands it to the pipeline without waiting on
the database.

| Status | Meaning |
| --- | --- |
| `200` | Accepted and counted |
| `400` | Malformed payload |
| `413` | Body, or decompressed body, over the size limit |
| `429` with `Retry-After` | Overloaded: event-loop lag, too many requests in flight, or a rollup backlog |
| `503` | Internal failure |

The collector never returns a retryable status for a batch it has already
counted, so a retrying exporter cannot double count.

`POST /v1/metrics` is accepted. TraceMap does not store metric points, but a
service that sends them appears on the map.

## Live stream

The browser subscribes to `GET /api/live`, a server-sent event stream that sends
`hello`, then a `structure` notice when the map's structure changes and a
`metrics` notice for each new snapshot. On a notice the browser fetches
`/api/live/structure` (JSON) or `/api/live/metrics` (a compact binary frame). The
server builds each snapshot once and compresses it once, for every viewer.
