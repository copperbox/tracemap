import pg from 'pg';
import { config } from '../config.js';

/** API reads. Kept apart from ingest so a slow dashboard query cannot stall the writers. */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.readPoolMax,
});

/** The collector's background writers (rollups, kept traces, catalog, compaction). */
export const ingestPool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.ingestPoolMax,
});

// An idle client erroring (database restart) must not crash the process.
pool.on('error', (err) => console.error('read pool client error:', err.message));
ingestPool.on('error', (err) => console.error('ingest pool client error:', err.message));

/** Query on the read pool. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

/** Query on the ingest pool. */
export async function ingestQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return ingestPool.query<T>(text, params as never[]);
}

export async function closePools(): Promise<void> {
  await Promise.allSettled([pool.end(), ingestPool.end()]);
}
