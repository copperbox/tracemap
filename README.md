# TraceMap

TraceMap is an OpenTelemetry collector with a live map of your services. It learns
the service topology from the traces your services already emit, so you can find
the service an incident starts in instead of working back from its symptoms team
by team.

![A critical service selected on a map of 5,000 services](docs/images/incident-5000.webp)

*5,000 services sending 20,000 spans a second. One click on the critical count in
the header lands on the failing service, with its errors and a sample trace for
each.*

Point any OTLP/HTTP exporter at it. A service appears on the map with its first
trace, and TraceMap infers the databases, queues and third-party APIs it calls
from span attributes.

## What you get

- **A live dependency map.** Every service and every caller-to-dependency edge,
  colored by health, with packets moving in the direction of the calls. Focus on
  one service's dependency cone, or isolate its tree.
- **Teams.** Services group into team frames from the `team.name` resource
  attribute. Collapse a team, or all of them, to see which team depends on which.
- **A path from a red node to a request.** Select a service to see its failing
  operations, the distinct errors behind each with exact counts, and a sample
  trace for each error.
- **Service pages.** Latency, throughput and error charts over any time range,
  top operations, callers and dependencies.
- **A wallboard and a services table**, both ranked worst first.
- **Curation.** Rename services, assign teams, add edges by hand, and merge
  duplicates. Merges are reversible.

| | |
| --- | --- |
| ![Service page](docs/images/service-page.webp)<br>Service page, 7 days of history | ![Trace waterfall](docs/images/trace-waterfall.webp)<br>A kept error trace: 52 spans across 14 services |
| ![Wallboard](docs/images/wallboard.webp)<br>Wallboard | ![Communities view](docs/images/communities.webp)<br>Communities: clusters found in the call graph |

The [feature guide](docs/features.md) covers each of these in detail.

## From 40 services to 5,000

The same map at four fleet sizes. The first is the bundled demo. The other three
are synthetic fleets from the [scale harness](docs/scale-harness.md), with live
traffic at about 4 spans a second per service.

| | |
| --- | --- |
| ![40 services](docs/images/map-demo.webp)<br>**40 services.** Every service is a card. | ![300 services](docs/images/scale-300.webp)<br>**300 services**, 10 teams, every team open. |
| ![1,000 services](docs/images/scale-1000.webp)<br>**1,000 services**, 33 teams. | ![5,000 services](docs/images/scale-5000-services.webp)<br>**5,000 services**, 10,300 edges, 167 teams. |

From 300 services up, the map opens with teams collapsed. This is the same 5,000
services as a map of teams:

![5,000 services collapsed into team nodes](docs/images/scale-5000-teams.webp)

Measured at 5,000 services on a 32-core workstation, with the database on local
NVMe. The [scale harness guide](docs/scale-harness.md) has the method and the full
numbers.

| | |
| --- | --- |
| Ingest | 20,000 spans/s sustained on one process. A collector-only test at 1,000 services took 154,000 spans/s. |
| Storage | 18 GB for 7 days of history |
| API | p50 under 10 ms for every endpoint the UI calls |
| UI | Pan, zoom and hover across all 5,000 services: no frame over 17 ms in Chrome, none over 34 ms in Firefox |

It stays fast because it does not store raw spans. The collector counts every
span into per-minute rollups and keeps whole traces only for errors, slow requests
and a small baseline. See [how it works](#how-it-works).

## Quick start

You need Docker, and Node 22 or newer for local development.

```sh
# Everything in containers: database, collector and API, and the web UI on :5173
docker compose up -d --build

# Or the database in Docker and the apps on your machine
docker compose up -d db
npm install
npm run migrate          # apply the schema
npm run dev              # API on :4000, OTLP on :4318, web on :5173

# Demo traffic: a 40-service shop with an incident in progress
npm run simulate
```

Open http://localhost:5173.

To see it at thousands of services, follow the
[scale harness guide](docs/scale-harness.md). It seeds 7 days of history and
drives live load.

## Send it your telemetry

1. Run TraceMap and open the UI.
2. Point your OTLP exporters at `http://<host>:4318`. Any OTEL SDK or collector
   works. `service.name` is the only resource attribute TraceMap needs.
3. Declare ownership with the `team.name` resource attribute. The standard
   environment variables need no code change:

   ```sh
   OTEL_SERVICE_NAME=checkout-svc
   OTEL_RESOURCE_ATTRIBUTES=team.name=Checkout
   ```

   TraceMap creates the team on first sight and assigns the service to it. The
   attribute only fills a missing assignment and never overwrites one made in the
   UI. At scale, set it centrally in an OpenTelemetry Collector processor, such
   as `k8sattributes` reading a pod label.
4. Assign the inferred dependencies. Databases, queues and SaaS APIs emit no
   telemetry, so they appear as nodes with no team. Give them a team and type in
   the UI, or with `PATCH /api/services/:id`.
5. Merge duplicates. If one service reports under two names, merge them. The old
   name becomes an alias and its history follows.

OTLP/gRPC on `:4317` is not implemented. Use OTLP/HTTP, which every OTEL SDK and
collector supports.

## How it works

```
 your services --OTLP/HTTP--> collector (:4318) --rollup rows, kept traces--> TimescaleDB
                                in-memory 1m cells,                          1m/10m/1h/1d rollup tiers
                                trace buffer, edge pairing                   kept_spans / kept_traces
                                      |
                                      v live window
 browser <--SSE notices-- web (React) <-- query API (:4000) <-- live snapshot + rollup reader
```

- **Rollups.** The collector counts every span into per-minute cells with a
  latency histogram, then compacts them into 10-minute, hourly and daily tiers.
  Counts and error rates are exact. Percentiles are accurate to one 10% bucket.
- **Kept traces.** The collector buffers each trace until it finishes, then keeps
  it if it has an error, if it is slow for its operation, or as a baseline, all
  within a budget of kept spans per second. It stores kept traces for 30 days.
- **Topology.** Edges come from joining client spans to the server spans they
  cause. Dependencies that emit no telemetry are inferred from attributes such as
  `db.system`, `messaging.system` and `server.address`.
- **Live map.** Every 2 seconds the server builds one snapshot of the whole map
  and shares it with every viewer.
- **Rendering.** The map draws on a canvas and mounts DOM cards only for the
  services on screen at a readable zoom.

More in [architecture](docs/architecture.md).

## Configuration

The server reads environment variables. The ones you are most likely to set:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://tracemap:tracemap@localhost:5433/tracemap` | TimescaleDB connection |
| `PORT` | `4000` | Query API |
| `OTLP_PORT` | `4318` | OTLP/HTTP collector |
| `KEPT_SPANS_PER_SEC` | `1000` | Budget for kept traces. The main control on trace storage. |
| `KEEP_ERROR_QUOTA` | `3` | Error traces kept per error signature per minute |
| `LIVE_WINDOW_MINUTES` | `5` | The window the map's current numbers cover |

[Configuration](docs/configuration.md) lists every variable and the simulator's
flags. [API](docs/api.md) lists the endpoints.

## Development

```sh
npm test            # server and web unit tests
npm run typecheck
```

The server's integration tests need a real TimescaleDB. They are skipped unless
`TEST_DATABASE_URL` points at a throwaway database:

```sh
TEST_DATABASE_URL=postgres://tracemap:tracemap@127.0.0.1:5544/tm_test npm test --workspace server
```

The dev server runs React in development mode, which makes every update two to
three times slower. To judge how the UI performs, use the production bundle:

```sh
npm run build --workspace web
npm run preview --workspace web      # http://localhost:4173, proxies /api like the dev server
```

[Architecture](docs/architecture.md) has the project layout.

## Limits

- Traces are a sample. Only kept traces can be listed or opened, so a trace id
  from your own logs may not be found. Counts, error rates and latencies come
  from the rollups, which count every span.
- Percentiles come from histograms with 10% buckets, so a p95 is accurate to
  about one bucket.
- Every span of a trace must reach the same collector process. Running more than
  one needs a load balancer that routes by trace id. See
  [architecture](docs/architecture.md#running-more-than-one-collector).
- The collector and the query API share one Node process. Under very heavy ingest
  the API slows down with it.
- Deleting a learned edge removes it until new telemetry learns it again.
  Deleting a manual edge is permanent.
- Upgrading from a version that stored raw spans leaves the old tables in place,
  unread. Their history is not converted. Drop them with
  `npm run legacy:drop --workspace server -- --yes` once you no longer need them.
- Tested in current Chrome and Firefox.

## Security

TraceMap has no authentication. Anyone who can reach port 4000 or 5173 can read
every service name, error message and kept trace, and can rename and merge
services. Anyone who can reach port 4318 can write telemetry.

Run it on a private network or behind your own access control. Do not expose it
to the internet. The Compose file sets a default database password and publishes
the database on localhost only. Change the password before you put real data in
it.

[docs/saml-auth-plan.md](docs/saml-auth-plan.md) is a design for SAML sign-in
through Okta and team-scoped editing. None of it is built yet.

## License

TraceMap is source-available under the
[PolyForm Shield License 1.0.0](LICENSE). You may use, change and share it for
any purpose, including inside a company, except to provide a product or service
that competes with TraceMap. A resold copy or a hosted version competes, whether
paid or free. The [LICENSE](LICENSE) file has the exact terms.
