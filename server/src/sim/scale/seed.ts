/**
 * `scale seed`: write the catalog and N days of rollup history for the
 * synthetic fleet straight into the tier tables, so charts, sparklines and
 * SLO rings have data before any load runs.
 *
 * What it leaves behind is what a long-running collector would have:
 * - 1d rows for whole days, 1h and 10m rows up to the compaction watermarks,
 *   1m rows for the recent minutes under a dedicated `collectors` row whose
 *   heartbeat is old (so it is never mistaken for a live collector).
 * - rollup_tier_state at the watermarks compaction would have reached, so
 *   compaction continues from the seeded 1m rows and never rebuilds a seeded
 *   coarse window.
 * - service_last_state / edge_last_state from the last seeded minutes.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import pg from 'pg';
import { config } from '../../config.js';
import { migrate } from '../../db/migrate.js';
import { HIST_BUCKETS, quantile } from '../../rollup/hist.js';
import { KEPT_TABLES, ROLLUP_KINDS, TIERS, tableName } from '../../rollup/tiers.js';
import type { Opts } from './args.js';
import { buildFleet, describeFleet, runtimeString, type Fleet } from './fleet.js';
import { calibrate, incidentWindows } from './model.js';
import { LAST_MINUTES, planSeed, type SeedPlan } from './seedGen.js';
import type { SeedWorkerInput, SeedWorkerOutput } from './seedWorker.js';
import { allOrCancel, type Cancellable } from './tasks.js';
import {
  SEED_COLLECTOR_HOST,
  askOnTerminal,
  beforeConnect,
  decide,
  describeTarget,
  formatTarget,
  inspectTarget,
  markComplete,
  markFailed,
  markRunning,
} from './target.js';

export { SEED_COLLECTOR_HOST };

const iso = (ms: number): string => new Date(ms).toISOString();

export interface SeedResult {
  elapsedMs: number;
  rows: Record<string, number>;
  dbBytes: number;
  plan: SeedPlan;
}

/** Tables `--reset` empties: the curated-storage tables and the catalog. Legacy tables are left alone. */
export function resetTables(): string[] {
  const rollups = ROLLUP_KINDS.flatMap((k) => TIERS.map((t) => tableName(k.kind, t.name)));
  return [
    ...rollups,
    'rollup_tier_state', 'rollup_dirty_windows', 'service_last_state', 'edge_last_state', 'kept_spans', 'kept_traces',
    'kept_trace_services', 'collectors', 'service_merges', 'service_aliases', 'edges', 'services', 'teams',
  ];
}

export function requireDb(opts: Opts): string {
  const url = opts.db as string | null;
  if (!url) {
    throw new Error('seed needs a database: pass --db postgres://... or set DATABASE_URL (it never falls back to the dev database)');
  }
  return url;
}

export interface SeedDeps {
  log?: (s: string) => void;
  /** Asks the user to confirm; defaults to a y/N prompt when stdin is a terminal. */
  confirm?: ((question: string) => Promise<boolean>) | null;
}

/**
 * Check the target before anything is written: show it, refuse the dev port
 * and databases with data the harness did not write (unless --force), refuse
 * a half-finished earlier seed (unless --reset), and require --yes or a
 * confirmation on the terminal.
 */
async function guardTarget(databaseUrl: string, opts: Opts, log: (s: string) => void, confirm: SeedDeps['confirm']): Promise<void> {
  const target = describeTarget(databaseUrl);
  log(`[seed] target: ${formatTarget(target)}`);
  const flags = { reset: !!opts.reset, yes: !!opts.yes, force: !!opts.force };
  const early = beforeConnect(target, flags);
  if (early?.action === 'refuse') throw new Error(early.reason);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let facts;
  try {
    facts = await inspectTarget(client);
  } finally {
    await client.end();
  }
  const d = decide(target, facts, flags, !!confirm);
  if (d.action === 'refuse') throw new Error(d.reason);
  if (d.action === 'confirm') {
    const what = facts.marker ? 'rewrite the harness data in' : 'migrate and seed';
    if (!(await confirm!(`${what} ${formatTarget(target)}?`))) throw new Error('not confirmed; nothing was written');
  }
}

export async function runSeed(opts: Opts, deps: SeedDeps = {}): Promise<SeedResult> {
  const log = deps.log ?? console.log;
  const confirm = deps.confirm !== undefined ? deps.confirm : process.stdin.isTTY ? askOnTerminal : null;
  const databaseUrl = requireDb(opts);
  await guardTarget(databaseUrl, opts, log, confirm);
  const started = performance.now();
  const step = (what: string) => log(`[seed ${((performance.now() - started) / 1000).toFixed(1)}s] ${what}`);

  const applied = await migrate(databaseUrl);
  if (applied.length) step(`applied migrations ${applied.join(', ')}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  let writing = false;
  const begin = async () => {
    if (writing) return;
    await markRunning(pool, { services: opts.services, teams: opts.teams, topologySeed: opts['topology-seed'], days: opts.days, rate: opts.rate });
    writing = true;
  };
  try {
    const result = await seedInto(pool, databaseUrl, opts, started, step, begin);
    await markComplete(pool);
    log(formatRows(result));
    return result;
  } catch (err) {
    // Once rows are written, leave the database marked half-seeded, so the next seed asks for --reset.
    if (writing) await markFailed(pool, err instanceof Error ? err.message : String(err)).catch(() => {});
    throw err;
  } finally {
    await pool.end();
  }
}

/** Everything after the guard. Calls `begin` just before its first write. */
async function seedInto(
  pool: pg.Pool,
  databaseUrl: string,
  opts: Opts,
  started: number,
  step: (s: string) => void,
  begin: () => Promise<void>,
): Promise<SeedResult> {
  if (opts.reset) {
    await begin();
    await pool.query(`TRUNCATE ${resetTables().join(', ')} CASCADE`);
    step('reset: emptied rollup, kept-trace and catalog tables');
  }

  const fleet = buildFleet({ services: opts.services as number, teams: opts.teams as number, seed: opts['topology-seed'] as number });
  step(`fleet: ${describeFleet(fleet)}`);
  const calib = calibrate(fleet, opts['calibrate-traces'] as number);
  const tracesPerSec = (opts.rate as number) / calib.spansPerTrace;
  step(`calibrated on ${calib.traces} traces: ${calib.spansPerTrace.toFixed(1)} spans/trace, ${tracesPerSec.toFixed(0)} traces/s at ${opts.rate} spans/s`);

  const plan = planSeed({
    nowMs: Date.now(),
    days: opts.days as number,
    recentMinutes: opts['recent-minutes'] as number,
    graceMinutes: config.rollupGraceMinutes,
    flushMs: config.rollupFlushMs,
    tracesPerSec,
  });
  step(`range ${iso(plan.startMs)} .. ${iso(plan.anchorMs)}; 1m from ${iso(plan.m0)}; watermarks 10m ${iso(plan.c10)}, 1h ${iso(plan.c1h)}, 1d ${iso(plan.c1d)}`);

  for (const w of incidentWindows(fleet, plan.anchorMs)) {
    const what = w.kind === 'error' ? `+${Math.round(w.magnitude * 100)}% errors` : `${w.magnitude.toFixed(1)}x latency`;
    step(`incident: ${fleet.nodes[w.node].id} ${what}, ${iso(w.startMs)} for ${Math.round((w.endMs - w.startMs) / 60_000)} min`);
  }
  const crit = fleet.nodes.filter((x) => x.health === 'crit').map((x) => x.id);
  step(`chronically failing (crit): ${crit.slice(0, 6).join(', ')}${crit.length > 6 ? `, ... (${crit.length})` : ''}`);

  // Upserting into compressed chunks from several workers deadlocks; start clean instead.
  const compressed = await pool.query<{ t: string }>(
    `SELECT DISTINCT hypertable_name AS t FROM timescaledb_information.chunks
     WHERE is_compressed AND hypertable_name = ANY($1::text[]) AND range_end > $2`,
    [resetTables(), iso(plan.startMs)],
  );
  if (compressed.rowCount) {
    throw new Error(`the seeded range already has compressed chunks (${compressed.rows.map((r) => r.t).join(', ')}); re-seed with --reset --yes`);
  }

  await begin();
  await writeCatalog(pool, fleet, calib.edgeOpRate, plan);
  const collectorId = await seedCollector(pool, plan);
  step(`catalog written (${fleet.teams.length} teams, ${fleet.nodes.length} services, ${fleet.edges.length} edges); seed collector id ${collectorId}`);

  const workers = Math.max(1, Math.min(opts.workers as number, os.availableParallelism()));
  const outputs = await runWorkers(fleet, calib, plan, databaseUrl, collectorId, workers, opts.chunk as number, step);
  const rows: Record<string, number> = {};
  for (const o of outputs) for (const [t, n] of Object.entries(o.counts)) rows[t] = (rows[t] ?? 0) + n;

  const lastRows = await writeLastState(pool, fleet, outputs, plan);
  rows.service_last_state = lastRows.services;
  rows.edge_last_state = lastRows.edges;
  await writeWatermarks(pool, plan);
  rows.rollup_tier_state = ROLLUP_KINDS.length * 3;

  if (opts.compress) {
    const before = await dbSize(pool);
    const chunks = await compressOld(databaseUrl, workers);
    step(`compressed ${chunks} chunks older than their compression policy (${gib(before)} -> ${gib(await dbSize(pool))})`);
  }

  const result = { elapsedMs: performance.now() - started, rows, dbBytes: await dbSize(pool), plan };
  step('done');
  return result;
}

const gib = (b: number) => `${(b / 2 ** 30).toFixed(1)} GiB`;

async function dbSize(pool: pg.Pool): Promise<number> {
  const r = await pool.query<{ b: string }>('SELECT pg_database_size(current_database()) AS b');
  return Number(r.rows[0].b);
}

/** Hypertables the seed writes and may compress: the rollup tiers and the kept-trace tables, nothing else. */
export function compressibleTables(): string[] {
  return [
    ...ROLLUP_KINDS.flatMap((k) => TIERS.map((t) => tableName(k.kind, t.name))),
    KEPT_TABLES.spans,
    KEPT_TABLES.traces,
    KEPT_TABLES.traceServices,
  ];
}

/**
 * Compress every chunk of the seeded hypertables that their compression
 * policy would already have compressed, as on a collector that has been
 * running for the seeded days. Other hypertables (legacy or unrelated) are
 * left alone. Chunks are independent, so they are compressed in parallel.
 */
async function compressOld(databaseUrl: string, parallel: number): Promise<number> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: parallel });
  try {
    const res = await pool.query<{ chunk: string }>(
      `SELECT c::text AS chunk
       FROM timescaledb_information.jobs j,
            LATERAL show_chunks(format('%I.%I', j.hypertable_schema, j.hypertable_name)::regclass,
                                older_than => (j.config->>'compress_after')::interval) c
       WHERE j.proc_name = 'policy_compression'
         AND j.hypertable_schema = current_schema()
         AND j.hypertable_name = ANY($1::text[])`,
      [compressibleTables()],
    );
    const queue = res.rows.map((r) => r.chunk);
    const work = async () => {
      for (let c = queue.pop(); c; c = queue.pop()) await pool.query('SELECT compress_chunk($1::regclass, true)', [c]);
    };
    await Promise.all(Array.from({ length: parallel }, work));
    return res.rows.length;
  } finally {
    await pool.end();
  }
}

export function formatRows(r: SeedResult): string {
  const names = Object.keys(r.rows).sort();
  const total = names.reduce((a, n) => a + r.rows[n], 0);
  const w = Math.max(...names.map((n) => n.length));
  const lines = names.map((n) => `  ${n.padEnd(w)}  ${r.rows[n].toLocaleString('en-US').padStart(12)}`);
  lines.push(`  ${'total'.padEnd(w)}  ${total.toLocaleString('en-US').padStart(12)}`);
  lines.push(`elapsed ${(r.elapsedMs / 1000).toFixed(1)} s, ${Math.round(total / (r.elapsedMs / 1000)).toLocaleString('en-US')} rows/s, database size ${(r.dbBytes / 2 ** 30).toFixed(2)} GiB`);
  return lines.join('\n');
}

async function writeCatalog(pool: pg.Pool, fleet: Fleet, edgeOpRate: Float64Array, plan: SeedPlan): Promise<void> {
  await pool.query('INSERT INTO teams (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING', [fleet.teams.map((t) => t.name)]);
  const n = fleet.nodes;
  await pool.query(
    `INSERT INTO services (id, type, team_id, runtime, region, is_external, slo_target, first_seen, last_seen)
     SELECT u.id, u.type, t.id, u.runtime, u.region, u.ext, u.slo, $8, $9
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bool[], $7::float8[])
       AS u(id, type, team, runtime, region, ext, slo)
     LEFT JOIN teams t ON t.name = u.team
     ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, team_id = EXCLUDED.team_id, runtime = EXCLUDED.runtime,
       region = EXCLUDED.region, is_external = EXCLUDED.is_external, slo_target = EXCLUDED.slo_target,
       first_seen = LEAST(services.first_seen, EXCLUDED.first_seen),
       last_seen = GREATEST(services.last_seen, EXCLUDED.last_seen)`,
    [
      n.map((x) => x.id),
      n.map((x) => x.type),
      // Team-owned databases and caches count as curated; shared queues and SaaS APIs stay unassigned.
      n.map((x) => (x.team != null ? fleet.teams[x.team].name : null)),
      n.map((x) => (x.lang ? runtimeString(x.lang) : null)),
      n.map((x) => (x.instrumented ? x.region : null)),
      n.map((x) => !x.instrumented),
      n.map((x) => x.sloTarget),
      iso(plan.startMs),
      iso(plan.anchorMs),
    ],
  );
  // sample_count: expected calls over the seeded range (the mean of trafficShape is about 0.55).
  const seconds = (plan.anchorMs - plan.startMs) / 1000;
  const samples = fleet.edges.map((e) => {
    let rate = 0;
    for (let j = 0; j < e.ops.length; j++) rate += edgeOpRate[e.opBase + j];
    return Math.round(rate * plan.tracesPerSec * seconds * 0.55);
  });
  await pool.query(
    `INSERT INTO edges (source_id, target_id, first_seen, last_seen, sample_count)
     SELECT u.s, u.t, $3, $4, u.n FROM unnest($1::text[], $2::text[], $5::bigint[]) AS u(s, t, n)
     ON CONFLICT (source_id, target_id) DO UPDATE SET sample_count = EXCLUDED.sample_count,
       first_seen = LEAST(edges.first_seen, EXCLUDED.first_seen), last_seen = GREATEST(edges.last_seen, EXCLUDED.last_seen)`,
    [fleet.edges.map((e) => n[e.s].id), fleet.edges.map((e) => n[e.t].id), iso(plan.startMs), iso(plan.anchorMs), samples],
  );
}

/** The seed's own collectors row, reused across runs so re-seeding overwrites its 1m rows. */
async function seedCollector(pool: pg.Pool, plan: SeedPlan): Promise<number> {
  const found = await pool.query<{ id: number }>('SELECT id FROM collectors WHERE host = $1 ORDER BY id LIMIT 1', [SEED_COLLECTOR_HOST]);
  if (found.rowCount) {
    await pool.query('UPDATE collectors SET started_at = $2, heartbeat_at = $2 WHERE id = $1', [found.rows[0].id, iso(plan.m0)]);
    return found.rows[0].id;
  }
  // Heartbeat at the start of the seeded 1m range: old, so readers never treat it as a live collector.
  const res = await pool.query<{ id: number }>(
    'INSERT INTO collectors (host, started_at, heartbeat_at) VALUES ($1, $2, $2) RETURNING id',
    [SEED_COLLECTOR_HOST, iso(plan.m0)],
  );
  return res.rows[0].id;
}

async function runWorkers(
  fleet: Fleet,
  calib: SeedWorkerInput['calib'],
  plan: SeedPlan,
  databaseUrl: string,
  collectorId: number,
  count: number,
  chunkRows: number,
  step: (s: string) => void,
): Promise<SeedWorkerOutput[]> {
  let nodesDone = 0;
  let lastReport = performance.now();
  const one = (index: number): Cancellable<SeedWorkerOutput> => {
    const input: SeedWorkerInput = { fleet: fleet.config, calib, plan, databaseUrl, collectorId, index, count, chunkRows };
    const w = new Worker(new URL(`./seedWorker${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url), { workerData: input });
    const done = new Promise<SeedWorkerOutput>((resolve, reject) => {
      w.on('message', (m: { progress?: number; done?: SeedWorkerOutput; error?: string }) => {
        if (m.progress) {
          nodesDone += m.progress;
          if (performance.now() - lastReport > 5000) {
            lastReport = performance.now();
            step(`rollups: ${nodesDone}/${fleet.nodes.length} nodes`);
          }
        }
        if (m.done) resolve(m.done);
        if (m.error) reject(new Error(`seed worker ${index}: ${m.error}`));
      });
      w.on('error', reject);
      w.on('exit', (code) => (code !== 0 ? reject(new Error(`seed worker ${index} exited with ${code}`)) : reject(new Error(`seed worker ${index} exited without a result`))));
    });
    return { done, cancel: () => w.terminate() };
  };
  step(`writing rollups with ${count} workers`);
  // One failed worker stops the others: a half-written seed is marked as such, not extended.
  return allOrCancel(Array.from({ length: count }, (_, i) => one(i)));
}

async function writeLastState(pool: pg.Pool, fleet: Fleet, outputs: SeedWorkerOutput[], plan: SeedPlan): Promise<{ services: number; edges: number }> {
  const seconds = LAST_MINUTES * 60;
  const svc = { id: [] as string[], rps: [] as number[], p50: [] as (number | null)[], p95: [] as (number | null)[], p99: [] as (number | null)[], err: [] as number[] };
  const edg = { s: [] as string[], t: [] as string[], rps: [] as number[], p50: [] as (number | null)[], p95: [] as (number | null)[], p99: [] as (number | null)[], err: [] as number[] };
  const q = (h: Float64Array, p: number) => {
    const v = quantile(h, p);
    return Number.isFinite(v) ? v : null;
  };
  for (const o of outputs) {
    for (const { node, last } of o.last) {
      if (last.svc && last.svc.n > 0 && last.svc.hist.length === HIST_BUCKETS) {
        svc.id.push(fleet.nodes[node].id);
        svc.rps.push(last.svc.n / seconds);
        svc.p50.push(q(last.svc.hist, 0.5));
        svc.p95.push(q(last.svc.hist, 0.95));
        svc.p99.push(q(last.svc.hist, 0.99));
        svc.err.push((last.svc.err / last.svc.n) * 100);
      }
      for (const e of last.edges) {
        if (e.n <= 0) continue;
        const fe = fleet.edges[e.edge];
        edg.s.push(fleet.nodes[fe.s].id);
        edg.t.push(fleet.nodes[fe.t].id);
        edg.rps.push(e.n / seconds);
        edg.p50.push(q(e.hist, 0.5));
        edg.p95.push(q(e.hist, 0.95));
        edg.p99.push(q(e.hist, 0.99));
        edg.err.push((e.err / e.n) * 100);
      }
    }
  }
  const at = iso(plan.anchorMs);
  await pool.query(
    `INSERT INTO service_last_state (service_id, at, rps, p50, p95, p99, err_pct)
     SELECT u.id, $1::timestamptz, u.rps, u.p50, u.p95, u.p99, u.err
     FROM unnest($2::text[], $3::float8[], $4::float8[], $5::float8[], $6::float8[], $7::float8[]) AS u(id, rps, p50, p95, p99, err)
     ON CONFLICT (service_id) DO UPDATE SET at = EXCLUDED.at, rps = EXCLUDED.rps, p50 = EXCLUDED.p50,
       p95 = EXCLUDED.p95, p99 = EXCLUDED.p99, err_pct = EXCLUDED.err_pct`,
    [at, svc.id, svc.rps, svc.p50, svc.p95, svc.p99, svc.err],
  );
  await pool.query(
    `INSERT INTO edge_last_state (source_id, target_id, at, rps, p50, p95, p99, err_pct)
     SELECT u.s, u.t, $1::timestamptz, u.rps, u.p50, u.p95, u.p99, u.err
     FROM unnest($2::text[], $3::text[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[]) AS u(s, t, rps, p50, p95, p99, err)
     ON CONFLICT (source_id, target_id) DO UPDATE SET at = EXCLUDED.at, rps = EXCLUDED.rps, p50 = EXCLUDED.p50,
       p95 = EXCLUDED.p95, p99 = EXCLUDED.p99, err_pct = EXCLUDED.err_pct`,
    [at, edg.s, edg.t, edg.rps, edg.p50, edg.p95, edg.p99, edg.err],
  );
  return { services: svc.id.length, edges: edg.s.length };
}

/**
 * Watermarks for every kind: 10m/1h/1d are complete below c10/c1h/c1d. Never
 * moved backwards, in case a collector already compacted further.
 */
async function writeWatermarks(pool: pg.Pool, plan: SeedPlan): Promise<void> {
  const kinds: string[] = [];
  const tiers: string[] = [];
  const at: string[] = [];
  for (const k of ROLLUP_KINDS) {
    for (const [t, ms] of [['10m', plan.c10], ['1h', plan.c1h], ['1d', plan.c1d]] as const) {
      kinds.push(k.kind);
      tiers.push(t);
      at.push(iso(ms));
    }
  }
  await pool.query(
    `INSERT INTO rollup_tier_state (kind, tier, compacted_through)
     SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[])
     ON CONFLICT (kind, tier) DO UPDATE
       SET compacted_through = GREATEST(rollup_tier_state.compacted_through, EXCLUDED.compacted_through)`,
    [kinds, tiers, at],
  );
}
