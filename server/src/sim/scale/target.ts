/**
 * Safety checks before `seed` touches a database. Seeding applies migrations,
 * writes tens of millions of rows and moves compaction watermarks, so the
 * target must be named, shown and confirmed, and must be a database the
 * harness owns (or an empty one).
 *
 * The harness recognizes its own databases by a one-row marker table it
 * writes (`scale_harness_seed`), which also records whether the last seed
 * finished.
 */
import { createInterface } from 'node:readline/promises';
import type pg from 'pg';
import { KEPT_TABLES, ROLLUP_KINDS, TIERS, tableName } from '../../rollup/tiers.js';

/** The user's own dev database (docker-compose) listens here. */
export const DEV_DB_PORT = 5433;

export const MARKER_TABLE = 'scale_harness_seed';

/** Collectors row the seed writes under; seeds from before the marker table are recognized by it. */
export const SEED_COLLECTOR_HOST = 'tracemap-scale-seed';

export interface Target {
  host: string;
  port: number;
  database: string;
}

/** Host, port and database name of a postgres:// URL (libpq defaults when parts are missing). */
export function describeTarget(url: string): Target {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('the database URL is not a URL (use postgres://user:pass@host:port/database)');
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error(`the database URL must start with postgres://, got ${u.protocol}//`);
  const host = decodeURIComponent(u.hostname) || u.searchParams.get('host') || 'localhost';
  const port = Number(u.port || u.searchParams.get('port') || 5432);
  const database = decodeURIComponent(u.pathname.replace(/^\//, '')) || decodeURIComponent(u.username) || 'postgres';
  return { host, port, database };
}

export const formatTarget = (t: Target) => `database "${t.database}" on ${t.host}:${t.port}`;

export interface Marker {
  state: 'running' | 'complete' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface TargetFacts {
  /** The harness's marker row, or a synthetic complete one when only the seed's collectors row exists. */
  marker: Marker | null;
  /** Tables (of services, rollups, kept traces) that hold at least one row. */
  tablesWithData: string[];
}

export interface GuardOpts {
  reset: boolean;
  yes: boolean;
  force: boolean;
}

export type GuardDecision = { action: 'refuse'; reason: string } | { action: 'confirm' } | { action: 'proceed' };

/**
 * Whether `seed` may write to `target`. Pure, so every rule is unit-tested:
 * 1. the dev port needs --force;
 * 2. data the harness did not write needs --force;
 * 3. a seed that did not finish needs --reset;
 * 4. --reset needs --yes;
 * 5. otherwise --yes, or an interactive confirmation when there is a terminal.
 */
export function decide(target: Target, facts: TargetFacts, opts: GuardOpts, interactive: boolean): GuardDecision {
  const where = formatTarget(target);
  const early = beforeConnect(target, opts);
  if (early) return early;
  if (!facts.marker && facts.tablesWithData.length && !opts.force) {
    const shown = facts.tablesWithData.slice(0, 4).join(', ') + (facts.tablesWithData.length > 4 ? ', ...' : '');
    return {
      action: 'refuse',
      reason: `${where} already holds data the harness did not write (${shown}). Seed an empty database, or add --force to write into this one anyway.`,
    };
  }
  if (facts.marker && facts.marker.state !== 'complete' && !opts.reset) {
    const how = facts.marker.state === 'failed' ? `failed${facts.marker.error ? `: ${facts.marker.error}` : ''}` : 'did not finish (interrupted, or still running elsewhere)';
    return {
      action: 'refuse',
      reason: `${where} is half-seeded: the seed started ${facts.marker.startedAt} ${how}. Re-seed from scratch with --reset --yes.`,
    };
  }
  if (opts.reset && !opts.yes) {
    return { action: 'refuse', reason: `--reset empties the rollup, kept-trace and catalog tables of ${where}; add --yes to confirm.` };
  }
  if (opts.yes) return { action: 'proceed' };
  if (interactive) return { action: 'confirm' };
  return { action: 'refuse', reason: `seed writes to ${where}; add --yes to confirm (no terminal to ask on).` };
}

/** The rules that need no connection, checked before the harness connects at all. */
export function beforeConnect(target: Target, opts: GuardOpts): GuardDecision | null {
  if (target.port === DEV_DB_PORT && !opts.force) {
    return {
      action: 'refuse',
      reason: `${formatTarget(target)}: port ${DEV_DB_PORT} is the dev database's port. Seed a throwaway database instead, or add --force if this is one.`,
    };
  }
  return null;
}

/** Tables whose rows mean "somebody's data": the catalog, every rollup and the kept traces. */
export function dataTables(): string[] {
  return ['services', ...ROLLUP_KINDS.flatMap((k) => TIERS.map((t) => tableName(k.kind, t.name))), KEPT_TABLES.traces];
}

/** Read the facts `decide` needs. Works before migrations: missing tables are simply empty. */
export async function inspectTarget(client: pg.Pool | pg.Client): Promise<TargetFacts> {
  const names = [...dataTables(), MARKER_TABLE, 'collectors'];
  const found = await client.query<{ name: string }>(
    `SELECT n AS name FROM unnest($1::text[]) AS n WHERE to_regclass(quote_ident(n)) IS NOT NULL`,
    [names],
  );
  const exists = new Set(found.rows.map((r) => r.name));
  const present = dataTables().filter((t) => exists.has(t));
  let tablesWithData: string[] = [];
  if (present.length) {
    const sql = present.map((t) => `SELECT '${t}' AS name WHERE EXISTS (SELECT 1 FROM ${t})`).join(' UNION ALL ');
    tablesWithData = (await client.query<{ name: string }>(sql)).rows.map((r) => r.name);
  }
  let marker: Marker | null = null;
  if (exists.has(MARKER_TABLE)) {
    const m = await client.query<{ state: Marker['state']; started_at: Date; finished_at: Date | null; error: string | null }>(
      `SELECT state, started_at, finished_at, error FROM ${MARKER_TABLE} WHERE id = 1`,
    );
    if (m.rowCount) {
      const r = m.rows[0];
      marker = { state: r.state, startedAt: r.started_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null, error: r.error };
    }
  }
  if (!marker && exists.has('collectors')) {
    const c = await client.query<{ started_at: Date }>('SELECT started_at FROM collectors WHERE host = $1 LIMIT 1', [SEED_COLLECTOR_HOST]);
    if (c.rowCount) marker = { state: 'complete', startedAt: c.rows[0].started_at.toISOString(), finishedAt: null, error: null };
  }
  return { marker, tablesWithData };
}

/** Record that a seed is writing. Until markComplete runs, the next seed calls the database half-seeded. */
export async function markRunning(client: pg.Pool, settings: Record<string, unknown>): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (
       id int PRIMARY KEY CHECK (id = 1),
       state text NOT NULL,
       started_at timestamptz NOT NULL,
       finished_at timestamptz,
       error text,
       settings jsonb
     )`,
  );
  await client.query(
    `INSERT INTO ${MARKER_TABLE} (id, state, started_at, settings) VALUES (1, 'running', now(), $1)
     ON CONFLICT (id) DO UPDATE SET state = 'running', started_at = now(), finished_at = NULL, error = NULL, settings = EXCLUDED.settings`,
    [JSON.stringify(settings)],
  );
}

export async function markComplete(client: pg.Pool): Promise<void> {
  await client.query(`UPDATE ${MARKER_TABLE} SET state = 'complete', finished_at = now() WHERE id = 1`);
}

export async function markFailed(client: pg.Pool, error: string): Promise<void> {
  await client.query(`UPDATE ${MARKER_TABLE} SET state = 'failed', finished_at = now(), error = $1 WHERE id = 1`, [error.split('\n')[0].slice(0, 500)]);
}

/** Ask y/N on the terminal. */
export async function askOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}
