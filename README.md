# TraceMap

TraceMap is an observability service for incident response. It acts as an OTLP
collector, learns your company's entire service topology from the traces and
metrics your services already emit, and renders it as a live interactive
dependency map -- so you can spot an incident at its *source* instead of
working backwards from symptoms team by team.

## What it does

- **Service map** - a live, pannable/zoomable graph of every known service
  (internal and external) and every learned caller -> dependency edge. Health
  is encoded as heat (green/amber/red) on node borders and edges. Edges show
  the direction of data flow: glowing packets travel from each dependency into
  the service that depends on it, ending in an arrowhead at the dependent's
  edge. The packets are drawn on a single screen-space canvas and culled to the
  viewport, so the map stays smooth at any zoom even with hundreds of edges.
  Their density reflects traces actually being received: edges with no current
  traffic (or only stale metrics) go quiet, and busier edges carry more
  packets. Edge anchors are direction-aware:
  each edge attaches to the side of a node that faces its counterpart, and
  edges sharing a side fan out instead of converging on one point, so
  dependency direction stays readable even in cyclic graphs or after manual
  drags. Nodes can be
  dragged to custom positions (edges follow; positions persist locally and a
  reset-layout button restores the default layout). The camera frames itself so
  the map is never left illegible: it fits the whole graph on load, centers and
  zooms to a selected node (click, or a deep link) at a readable level clear of
  the drawer, and reframes onto the dependency cone when you focus or isolate.
  When zoomed too far out to read, node labels are hidden (cards become clean
  status boxes) and a "zoom in to read labels" hint shows, so the overview reads
  as intentional rather than a blur; the zoom level where labels appear is a
  user preference (see below), defaulting to the tuned threshold. No date selection needed:
  the map always
  shows the current (or last-known) state of everything, even services with
  no recent traffic.
- **Team frames and meganodes** - services are assigned to owning teams,
  automatically from the `team.name` OTEL resource attribute when present
  (teams are created on the fly) or manually through the UI/API. Each
  unmerged team's services are laid out together inside a labeled "frame"
  (like a box on an infrastructure diagram), so node ownership is always
  visible. The frame's title bar carries the team name, member count, and a
  merge button that collapses the team into a single meganode; dragging the
  title bar moves the whole team at once. Merging every team (the
  "Merge all teams" shortcut) turns hundreds of nodes into a clean
  "team depends on team" view, and any single meganode can be unmerged back
  into its framed services for selective deep dives. External dependencies
  stay individual until you manually assign them to a team. Merge changes
  happen in place: a team keeps its spot on the map when toggled (including
  teams you have dragged elsewhere), with other frames shifting just enough
  to avoid overlap. The changes animate -- merged services visibly converge
  into their meganode, unmerged services fly back out of it -- so it is
  always clear which nodes just merged or split. Aggregating teams usually makes the graph cyclic (most
  teams end up mutually dependent); the layout breaks those cycles with a
  greedy feedback-arc ordering so the dominant flow still runs top-to-bottom
  and only a minimal set of backward edges points up.
- **Graph types (Map / Communities)** - a toggle in the top-right switches the
  service map between two layouts. "Map" is the default layered dependency-flow
  view described above. "Communities" is a force-directed graph (d3-force)
  rendered on a canvas so it scales to hundreds of nodes: services become
  Obsidian-style dots sized by traffic and colored by community, with edges as
  light links and labels that appear on hover/selection or when zoomed in.
  Community colors are confined to cool hues (cyan through magenta) so they can
  never be confused with the red/amber/green a node's status ring uses.
  Communities are detected automatically with label propagation over the call
  graph (structure only, so they stay stable across metric polls and only shift
  when the topology changes), revealing clusters of tightly-coupled services
  independent of team ownership. The simulation pre-settles before the first
  paint and stays cooled until you drag a node (which reheats it), so an idle
  graph costs no CPU. Both views share the same selection/focus/search/team
  filtering and the same inspector drawer. The team filter is a searchable
  dropdown (type to narrow the team list, pick a team or "Unassigned" for
  services with no owner) reused across the map and the services list.
- **Header health counts** - the top-bar healthy / degraded / critical counts
  are a live triage entry point. Clicking the degraded or critical count opens a
  list of exactly those services (worst-first by error rate, then tail latency);
  picking one jumps to the map with that service selected -- camera panned to it
  and its inspector drawer open. Escape or a click outside dismisses the list.
- **User preferences** - a cog in the header opens a preferences popover with
  the theme (dark/light) and the "map labels" setting: how far you must zoom in
  before node labels show (Always / Zoomed out / Default / Zoomed in), applied
  to both the layered map and the communities view. Preferences persist in
  localStorage (`tracemap.prefs`), so the theme and label threshold survive
  reloads.
- **Services list** - a sortable table of every service (health, traffic, p95,
  error rate, 30-day SLO, and a 24h latency sparkline), ranked worst-health
  first. The shared searchable team filter scopes the table to one team -- or
  to "Unassigned" for services that belong to no team -- and the global search
  box narrows by name.
- **Wallboard** (`/wallboard`) - the same services, filters, and worst-health-first
  ranking as the list, rendered as a card grid readable from across the room:
  one card per service with its status, error rate, p95, req/s, and 24h latency
  sparkline, the whole card tinted when a service is degraded or critical.
  Clicking a card slides in the same service inspector as the map's node
  drawer (SLO, KPIs, sparklines, callers/dependencies, top erroring
  operations); its dependency rows jump between cards, and the footer links
  out to the full service page or the map isolated to that service's tree.
- **Inspector drawer** - click any node, meganode, or edge to inspect SLO
  attainment + error budget, KPIs, 24h sparklines (hovering one moves the
  crosshair on all of them so the same instant is easy to compare),
  callers/dependencies, and for edges: the learned relationship (first
  observed, supporting spans, confidence, auto vs manual source) and the
  observed operation mix. Selecting a node or edge also lists its top erroring
  operations and, under each, the distinct errors seen (exception types, HTTP
  status codes, queue/db error codes) with exact counts, each linked to a kept
  sample trace when one exists.
  The drawer footer can **focus** the selection (dims everything outside its
  dependency cone while keeping the rest on screen) or, on the layered map,
  **isolate** it: the map is redrawn for that node/team/edge's dependency tree
  alone, dropping every other node so a large tree becomes legible. Isolation is
  a deep link (`?isolate=<key>`); a "View isolated tree" action on each service
  page jumps straight to that service's isolated tree, and a top-centre banner
  with an Exit button returns to the full map. (Communities offers focus only --
  it cannot prune to a subtree.)
- **Service pages** - per-service deep dive with KPI cards,
  latency/throughput/error-rate charts (crosshair hover tooltips that stay in
  sync across the charts), top
  operations, linked upstream/downstream services, and recent kept traces
  (each marked with why it was kept: error, slow or baseline).
  A top-erroring-operations panel lists each failing operation with the
  distinct errors seen; clicking one filters the recent-traces list to that
  operation's failing traces (click again, or the filter chip, to clear).
  A Kibana-style date/time picker (quick ranges or absolute from/to) scopes
  everything on the page. Each section (header/KPIs/charts, top errors, recent
  traces) loads independently behind its own shimmer skeleton, and the heavier
  chart bundle is code-split, so the page shell paints immediately instead of
  blocking on one combined request.
- **Trace waterfall** - click a trace to open the full distributed span tree
  with timing bars and raw OTEL span attributes. Only kept traces can be
  opened (see [Notes & limitations](#notes--limitations)).
- **Manual curation** - rename services, set descriptions, owning team/group,
  type and SLO target; manually associate dependencies the inference cannot
  see; and merge duplicate services (same service reported under different
  names) into one canonical service -- the old name becomes an alias for all
  future traffic, and its history shows up under the canonical service. The duplicate picker
  is the same searchable dropdown used elsewhere, scoped to team-less services
  (assigned ones are deliberately owned, not stray duplicates). Merges are
  reversible: each merge is recorded, so the edit modal lists everything merged
  into a service and an Unmerge button splits a duplicate back out -- restoring
  its service, history and edges.

## Architecture

```
 your services --OTLP/HTTP--> collector (:4318) --rollup rows, kept traces--> TimescaleDB
                                in-memory 1m cells,                          1m/10m/1h/1d rollup tiers
                                trace buffer, edge pairing                   kept_spans / kept_traces
                                      |
                                      v live window
 browser <--SSE push-- web (React) <-- query API (:4000) <-- live snapshot + rollup reader
```

- `server/` - Node.js + TypeScript.
  - **OTLP collector** (`:4318`): accepts `POST /v1/traces` and
    `POST /v1/metrics` in both `application/x-protobuf` (vendored
    opentelemetry-proto definitions) and `application/json`, per the
    [OTLP spec](https://opentelemetry.io/docs/specs/otlp/). A request is
    decoded and handed to the pipeline without waiting on the database. A
    malformed payload gets `400`; an overloaded collector answers `429` with
    `Retry-After`; an internal failure is `503`.
  - **Rollups, not raw spans**: the collector counts every span into
    per-minute cells in memory (per service, operation, edge, edge operation
    and error signature) with a latency histogram, and writes those cells as
    rollup rows. Raw spans are not stored. The cells of the last few minutes
    stay open and are rewritten on each flush, so late spans still count.
    Compaction builds the `10m` tier from `1m`, `1h` from `10m` and `1d` from
    `1h` (one process at a time, under an advisory lock). Retention: `1m` 3
    days, `10m` 30 days, `1h` 395 days, `1d` forever.
  - **Trace curation**: spans are buffered per trace until the trace has been
    quiet for 10 s (or is 30 s old), then the trace is kept or dropped. Kept:
    errors (a few per error signature per minute), slow traces (root duration
    at or above its root operation's p99) and a baseline (one per root
    operation per minute), all under a global budget of kept spans per second.
    Kept traces are stored for 30 days; everything else is counted in the
    rollups and discarded.
  - **Topology inference**: cross-service edges are learned by joining CLIENT
    spans to the SERVER spans they cause (works regardless of batch arrival
    order); databases, queues, and external APIs that never emit telemetry are
    inferred from semantic-convention attributes (`db.system`,
    `messaging.system`, `peer.service`, `server.address`, `url.full`, ...).
    Edge metrics are always the *caller's* measurements of the dependency.
  - **Live snapshot**: every 2 s the server builds one snapshot of the whole
    map in memory, from the collector's live window plus the last known state
    of services with no current traffic, and shares it with every viewer. The
    browser subscribes to `/api/live` (server-sent events) and fetches the
    map structure and a compact binary metrics frame when they change.
  - **Query API** (`:4000`): live numbers come from the snapshot; history comes
    from the rollup tiers (the coarsest tier that fits the range, with finer
    tiers stitched in for the recent part). The API reads no raw spans.
    Also traces, teams, and the curation endpoints (rename/merge/manual edges).
- `web/` - React + Vite + zustand. The map (layered DAG layout - leaf
  dependencies on top, gateway at the bottom) draws nodes and edges on a canvas
  and mounts DOM cards only for nodes on screen at a readable zoom; long lists
  render only their visible rows. Charts, and the full UI from the design
  handoff (dark/light themes, green accent). The current view is reflected in
  the URL (see [Deep links](#deep-links)), so reloads and shared links land on
  the same place.
- **TimescaleDB**: the rollup tiers and kept traces are compressed hypertables
  with retention policies (the `1d` tier is a plain table); the service
  catalog, teams, edges, aliases and merges are plain tables.

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

### Deep links

The whole UI is URL-addressable, so every view survives a reload and can be
shared as a link. The store and the address bar are kept in sync (no routing
library - a small `web/src/state/routing.ts` encoder plus a `urlSync.ts` glue
layer bound to the History API), and the browser back/forward buttons move
between views as expected.

```
/                     service map (layered dependency flow)
/communities          service map (force-directed, clustered by community)
/services             services list
/service/<id>         service detail
/wallboard            wallboard (one card per service)

?trace=<id>           open a trace in the modal overlay (any view)
?range=q.<ms>         quick time range  (e.g. q.3600000 = last 1 hour)
?range=a.<from>.<to>  absolute time range (epoch ms)
?team=none|<id>       team filter (omitted when "all teams")
?isolate=<key>        render only this node/team/edge's dependency tree
                      (layered map only; ignored on every other view)
```

Default values (24h range, all teams) are left out of the URL to keep links
clean. Serving requires the usual SPA fallback to `index.html`; the bundled
`web/nginx.conf` and the Vite dev server both already do this.

## Onboarding your services

The optimal path from zero to a curated live map:

1. **Run TraceMap** (`docker compose up -d --build`) and open the UI.
2. **Point OTLP exporters at the collector.** Any OTEL SDK or collector works:
   set the OTLP/HTTP endpoint to `http://<host>:4318`. `service.name` is the
   only required resource attribute -- each unique name becomes a map node on
   its first trace, and caller -> dependency edges are learned automatically.
3. **Declare ownership with the `team.name` resource attribute.** The
   lowest-friction way is the standard environment variable -- no code changes:

   ```sh
   OTEL_SERVICE_NAME=checkout-svc
   OTEL_RESOURCE_ATTRIBUTES=team.name=Checkout
   ```

   When the first trace from a service arrives, TraceMap creates the team if
   it does not exist yet and assigns the service to it. The attribute only
   fills a *missing* assignment -- it never overwrites a team set through the
   UI or API, so manual curation stays authoritative. At scale, inject the
   attribute centrally from an OTel Collector processor (`k8sattributes`
   pulling a pod label, or a `resource` processor) instead of per service.
4. **Curate the inferred dependencies.** Databases, queues, and external SaaS
   APIs never emit their own telemetry, so they appear as inferred nodes with
   no team. Assign their team and type in the UI (or
   `PATCH /api/services/:id` with `{"teamName": "...", "type": "..."}`).
5. **Tidy duplicates.** If the same service reports under different names,
   merge them -- history is re-pointed and the old name becomes an alias.

The bundled simulator (`npm run simulate`) demonstrates this exact flow: its
instrumented services carry `team.name` on every trace, so teams are created
and ownership is assigned purely from telemetry. Its databases, queues, and
SaaS peers emit no telemetry of their own, so -- like real inferred
dependencies -- they show up unassigned for you to curate in step 4.

## Configuration

Server settings are environment variables (`server/src/config.ts`):

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

Simulator flags: `npm run simulate -- --otlp http://127.0.0.1:4318 --api http://127.0.0.1:4000 --tps 6`.
While the simulator runs in a terminal, dial the trace rate live: `+` doubles
it, `-` halves it (clamped to 0.25-96 traces/s), `0`/space/`p` pauses and
resumes, `q` quits.

For stress testing and demos, the topology can be scaled up past the curated
40-service demo (the demo is always kept as the recognizable core; synthetic
teams and services are layered on top):

| Flag           | Env             | Default | Purpose                                                                 |
| -------------- | --------------- | ------- | ----------------------------------------------------------------------- |
| `--services`   | `SIM_SERVICES`  | `0`     | Target total node count; augments the demo with synthetic teams to reach it (0 = demo only). |
| `--teams`      | `SIM_TEAMS`     | `0`     | Number of synthetic teams to spread the generated services across (0 = derive from count). |
| `--unassigned` | `SIM_UNASSIGNED`| `0`     | Number of team-less inferred peers to mint (never seeded -- they stay unassigned). |
| `--dup-ratio`  | `SIM_DUP_RATIO` | `0.4`   | Fraction of unassigned peers minted as duplicate pairs: two names for one backend, to test merging. |

Synthetic teams own a varied number of services, so the map shows realistic
size differences. The unassigned duplicate pairs (e.g. `billing-2.example.com`
and `api.billing-2.io`, or `media-cdn-1-db` and `pg-media-cdn-1`) are two
distinct inferred nodes that stand for one backend -- merge them in the UI or
with `POST /api/services/:id/merge` to exercise association. Example:
`npm run simulate -- --services 300 --unassigned 40 --dup-ratio 0.5 --tps 24`.

## API overview

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

## Testing

```sh
npm test          # server (OTLP decode, pipeline, rollups, live snapshot, API) + web (layout, grouping, live client)
```

Integration tests run against a real TimescaleDB and are skipped unless
`TEST_DATABASE_URL` points at a throwaway database, e.g.
`TEST_DATABASE_URL=postgres://tracemap:tracemap@127.0.0.1:5544/tm_test npm test --workspace server`.

The scale harness (`npm run scale -- seed|load|probe|all`) seeds a database with
5,000 services and 7 days of history, drives live OTLP load and times every
endpoint the UI uses. See [docs/scale-harness.md](docs/scale-harness.md).

## Project layout

Modules keep a focused scope of concern: routes, simulator stages, and UI
sections are split into small files rather than monoliths. On the web side,
component styles live in colocated CSS Modules (`X.module.css` next to
`X.tsx`); only genuinely dynamic values (computed transforms, per-datum
colors) stay inline, and shared design tokens are CSS variables in
`web/src/theme/global.css`.

```
server/src/otlp/      OTLP decode (vendored protos), peer inference, service registry, ingest routes
server/src/pipeline/  rollup cells, edge pairing, trace buffer and curation, kept-trace writer
server/src/rollup/    tier metadata, histogram codec, tier compaction, rollup reader
server/src/live/      live snapshot, structure + binary metrics frame, SSE hub
server/src/api/       routes split per resource (service list/detail/edit/merge,
                      topology, traces, errors, teams, series) + shared range parsing
server/src/db/        migrations (TimescaleDB schema), pools, legacy table drop
server/src/sim/       demo traffic generator, split by stage (args, topology +
                      procedural augmentation, trace gen, OTLP payload encoding,
                      http, metrics sampling)
server/src/sim/scale/ scale harness: synthetic fleet, history seed, OTLP load, API probe
docs/                 scale harness guide
web/src/state/        store, URL sync, live stream client
web/src/dev/          dev-only synthetic topology (`?synthetic=N`)
web/src/lib/          DAG layout, team grouping, community detection, time ranges, formatters, timeSince
web/src/theme/        global CSS tokens/keyframes + font shorthand helpers
web/src/features/     map (MapView switches LayeredMap / force/ communities graph,
                      view/ render layers, MapDrawer + drawer/ panels),
                      services list, service page (+ sections/), trace waterfall
web/src/components/   top bar, charts, sparklines, SLO ring, icons
```

## Notes & limitations

- Traces are a sample. Only kept traces (errors, slow, baseline, under the
  `KEPT_SPANS_PER_SEC` budget) can be listed or opened, so a trace id from your
  own logs may not be found. Counts, error rates and latencies come from the
  rollups, which count every span.
- Latency quantiles (p50/p95/p99) are estimated from log histograms whose
  buckets are 10% wide, so a quantile is accurate to about one bucket.
- Merging services touches only the catalog (aliases, edges, the merged
  service). History recorded under the old name is found at read time, so a
  merge or unmerge is cheap at any data size.
- Upgrading from a version that stored raw spans leaves the old tables
  (`spans`, `edge_events`, `metric_points` and their continuous aggregates) in
  place, unread and unwritten. Drop them with
  `npm run legacy:drop --workspace server -- --yes` once you no longer need them.
- Each collector process pairs edges and decides traces on its own, so every
  span of a trace must reach the same process. Running more than one collector
  needs a load balancer in front that routes by trace id (for example the
  OpenTelemetry Collector's `loadbalancing` exporter with `routing_key: traceID`).
- Deleting a *learned* edge removes it until new telemetry re-learns it;
  deleting a *manual* edge is permanent.
- OTLP/gRPC (`:4317`) is not implemented; use OTLP/HTTP (`:4318`), which every
  OTEL SDK and collector supports.
