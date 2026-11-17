# Scale harness

`npm run scale -- <command>` simulates a company of about 5,000 services against a
TraceMap server, so you can watch the app work at that size. It has four commands:

- `seed` writes the service catalog and 7 days of rollup history straight into the database.
- `load` sends live OTLP traffic for the same fleet at a target span rate.
- `probe` times every API endpoint the UI uses and checks the live stream.
- `all` runs `seed`, then `load`, with a `probe` every minute.

The fleet is generated from a seed number, so `seed` and `load` describe the same
services, edges and failure rates as long as `--services`, `--teams` and
`--topology-seed` match. The code is in `server/src/sim/scale/`.

## Prerequisites

- Docker, Node 22 or newer, and `npm install` run once at the repo root.
- About 25 GB of free disk for the default seed (5,000 services, 7 days).
- Several cores help: `seed` runs 8 worker threads, one database connection each.

## 1. Start a throwaway database

Put it on its own port so your normal dev database (port 5433) is not touched:

```sh
docker run -d --name tracemap-scale --shm-size 1g -p 127.0.0.1:5544:5432 \
  -e POSTGRES_USER=tracemap -e POSTGRES_PASSWORD=tracemap -e POSTGRES_DB=tracemap \
  timescale/timescaledb-ha:pg16
docker exec tracemap-scale psql -U tracemap -c 'CREATE DATABASE tm_scale'
export DATABASE_URL=postgres://tracemap:tracemap@127.0.0.1:5544/tm_scale
```

`seed` never falls back to the dev database: without `--db` or `DATABASE_URL` it stops.

## 2. Seed

Stop any server using the database first; a running collector and a `--reset` get in
each other's way.

```sh
npm run scale -- seed --reset --yes
```

`seed` applies the migrations, then writes:

- teams, services and edges (`teams`, `services`, `edges`);
- every rollup kind at every tier: `1d` for the 7 whole days, `1h` and `10m` up to
  the current compaction point, `1m` for the last 120 minutes up to the current
  minute, under its own `collectors` row (host `tracemap-scale-seed`, old heartbeat);
- `rollup_tier_state` at the point tier compaction would have reached, so the server
  carries on from the seeded `1m` rows and never rebuilds a seeded window;
- `service_last_state` / `edge_last_state` from the last 5 seeded minutes;
- then it compresses the chunks older than their compression policy, as a
  long-running system would have.

The history is shaped like real traffic: a daily curve (peak 15:00 UTC, 20% of peak
at 03:00), 30% less at weekends, latency histograms per operation, a few historical
incidents (error or latency spikes on one service, listed in the output, one of them
about 95 minutes ago), and error-signature rows. It is scaled so that the current time
of day matches `--rate` (default 20,000 spans/s), so the charts run straight into the
live load. Running `seed` again without `--reset` rewrites the same rows, but it refuses
when the seeded range already has compressed chunks (after a 7-day seed it does); use
`--reset --yes` then.

| flag | default | |
|---|---|---|
| `--services` | 5000 | nodes on the map, including about 5% inferred peers (databases, queues, SaaS APIs) |
| `--teams` | 0 | 0 = one team per 30 nodes |
| `--topology-seed` | 1 | change it for a different company |
| `--days` | 7 | whole days of history |
| `--recent-minutes` | 120 | minutes of 1m rows |
| `--rate` | 20000 | spans/s the history is scaled to |
| `--workers` | 8 | threads and connections |
| `--reset --yes` | | empty the rollup, kept-trace and catalog tables first (legacy tables are left alone) |
| `--compress=false` | | skip the compression step |

## 3. Start the server and the web app

From `server/`, against the same database, on ports that do not clash with dev:

```sh
cd server
DATABASE_URL=$DATABASE_URL PORT=4403 OTLP_PORT=4421 node --import tsx src/index.ts
```

In another terminal, from the repo root:

```sh
API_PROXY_TARGET=http://127.0.0.1:4403 npm run dev --workspace web
```

Run the server with `node --import tsx` rather than `npx tsx`: Ctrl-C and `kill` then
reach the server process itself, not an npm wrapper that leaves it running.

## 4. Load

```sh
npm run scale -- load --otlp http://127.0.0.1:4421 --duration 10m \
  --incident payments-platform-payouts-processor
```

`load` registers every service with one request, then sends protobuf exports over
keep-alive connections at the target rate. Each request carries whole traces
(about 32 spans each), with unique trace ids and current timestamps, and the same
error and latency behavior as the seeded history. It honors `429`/`503` with
`Retry-After` and counts retries. A status line every 5 s shows target, sent and
accepted spans/s, 4xx/429/5xx counts, request p50, how many connections were busy,
and how much of its thread the generator used. When the rate falls short it says why:
`generator-bound`, `collector is shedding load (429)` or `connection-bound`.

| flag | default | |
|---|---|---|
| `--rate` | 20000 | spans/s |
| `--duration` | until Ctrl-C | `90s`, `5m`, `1h` |
| `--connections` | 8 | keep-alive connections |
| `--batch` | 1000 | spans per request |
| `--gzip` | off | gzip bodies, as most OTLP exporters do |
| `--incident <id>` | none | push this service into errors while running |
| `--incident-rate` | 0.3 | failure probability added |
| `--incident-after` | 30s | when the incident starts |

The incident service id must exist in the fleet; pick one from the map or from the
`services` table (one that has a few callers shows the edges turning red as well).

## 5. Probe

```sh
npm run scale -- probe --api http://127.0.0.1:4403 --out probe.json
```

For each endpoint the UI uses, `probe` makes 5 requests and prints status, p50 and max
latency, the raw size and the gzip size (the server's own when it compressed, marked
`*` when the probe computed it). It picks the worst service on the map, one of its
callers and a kept trace. It decodes `/api/live/metrics`, checks it against
`/api/live/structure`, watches `/api/live` for 10 s and prints `/api/health`. An
endpoint the server does not have is reported as `not available`.

`npm run scale -- all --api http://127.0.0.1:4403 --otlp http://127.0.0.1:4421` does
all of it in one go (`--no-seed` to skip the seed, `--probe-every 60s`).

## What to look at

- Map: about 5,000 nodes and 10,300 edges. Around 30 services are red at any time:
  14 fail chronically, about 45 sit at 1 to 2% errors and cross into red now and then,
  and quiet services flicker when one error lands in a small window. With
  `--incident`, the service turns red within a minute, and so do the edges into it.
- Service page, 7 d: the daily curve and the weekend dip, and the incident spikes.
  1 h: the recent incident if it is still in range, then live data from the load.
- SLO rings: chronic failures and services with an incident miss their target.
- Errors: signatures per operation. Live errors link to a sample trace; seeded history
  has no traces behind it.
- Traces: only from the load, and only the kept sample (errors, slow, baseline),
  about 650 spans/s of the 20,000.

## Measured numbers

32-core workstation, database on local NVMe, scratch TimescaleDB 2.32 / PG16 container
shared with other work, November 2026. Defaults unless stated.

Seed, 5,000 services, 7 days: 61.1 to 61.5 million rows in 162 to 171 s on a quiet
database (about 380,000 rows/s; 320 s when another load was running against the same
container). 22.6 GiB written, 18.3 GiB after compressing the old chunks. The largest
tables are `edge_op_rollup_10m` (15.9 M rows), `edge_rollup_10m` (10.9 M),
`op_rollup_10m` (9.2 M) and `svc_rollup_10m` (5.0 M).

Load, 20,000 spans/s for 240 s: 20,001 spans/s sent and accepted, 4,694 requests, no
non-200 answers, request p50 9 ms. One thread builds about 500,000 spans/s, so the
generator used 7% of its core. The server's RSS was about 1.0 GB at the end. Every
one of the 4,744 instrumented services had a `svc_rollup_1m` row each minute (about
497,000 requests a minute). Kept traces: about 650 spans/s, under the 1,000 budget.

Probe during that load (p50 / max over 5 requests, sizes raw / gzip):

| endpoint | p50 ms | max ms | raw | gzip |
|---|---:|---:|---:|---:|
| live structure | 3.7 | 32 | 3.0 MB | 216 KB |
| live metrics frame | 1.2 | 13 | 314 KB | 91 KB |
| topology | 8.0 | 75 | 5.9 MB | 530 KB |
| services | 4.9 | 908 | 3.8 MB | 236 KB |
| service detail 1 h / 24 h / 7 d | 2.0 / 2.0 / 2.6 | 26 / 2.6 / 15 | 11 KB | 2 KB |
| sparklines, edge series, errors, trace list, trace | 0.8 to 1.4 | 2 to 10 | 0.3 to 15 KB | |
| live stream | one `metrics` event every 2.1 s | | | |

The `services` max is the first request after start, which fills the sparkline cache.

## Knobs worth turning

Server settings (`server/src/config.ts`, environment variables):

- `KEPT_SPANS_PER_SEC` (1000): the kept-trace budget. The main lever on database
  writes and disk for traces.
- `TRACE_BUFFER_MAX_SPANS` (1,000,000): spans held for undecided traces; memory.
- `EDGE_RESOLVE_MAX_PENDING` (500,000): unpaired client spans held; memory.
- `MAX_OPS_PER_SERVICE` (200), `MAX_ERROR_SIGS_PER_SERVICE` (100): caps on rollup keys.
- `ROLLUP_FLUSH_MS` (10 s), `ROLLUP_GRACE_MINUTES` (3): write cadence and how long a
  minute stays open. `seed` reads both to place the watermarks; give it the same values
  as the server.
- `INGEST_POOL_MAX` (6), `READ_POOL_MAX` (10): connections for writers and API reads.
- `OVERLOAD_LAG_MS` (1000), `OVERLOAD_MAX_INFLIGHT` (512): when ingest answers 429.
- `LIVE_WINDOW_MINUTES` (5), `SNAPSHOT_INTERVAL_MS` (2000): the live map's window and
  refresh rate.
- `COMPACT_INTERVAL_MS` (60 s): how often tier compaction runs.

Harness: `--services` and `--rate` for size, `--connections` and `--batch` if the status
line says `connection-bound`, `--days` to shorten the seed.

## Cleanup

```sh
docker rm -f tracemap-scale
```

or keep the container and drop the database:
`docker exec tracemap-scale psql -U tracemap -c 'DROP DATABASE tm_scale'`.
