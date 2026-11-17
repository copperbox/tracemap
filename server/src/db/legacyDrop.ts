/**
 * Drops the pre-rollup storage: the raw spans / edge_events / metric_points
 * hypertables and the three continuous aggregates built on them. Nothing
 * writes them since migration 003. Irreversible, so it does nothing unless
 * passed --yes.
 *
 *   npm run legacy:drop --workspace server -- --yes
 */
import pg from 'pg';
import { config } from '../config.js';

export const LEGACY_CAGGS = ['service_op_metrics_1m', 'edge_metrics_1m', 'edge_op_metrics_1m'] as const;
export const LEGACY_TABLES = ['spans', 'edge_events', 'metric_points'] as const;

async function main(): Promise<void> {
  const yes = process.argv.includes('--yes');
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    const sizes = await client.query<{ name: string; size: string | null }>(
      `SELECT n AS name, pg_size_pretty(hypertable_size(n::regclass)) AS size
       FROM unnest($1::text[]) AS n WHERE to_regclass(n) IS NOT NULL`,
      [LEGACY_TABLES],
    );
    const present = await client.query<{ view_name: string }>(
      'SELECT view_name FROM timescaledb_information.continuous_aggregates WHERE view_name = ANY($1)',
      [LEGACY_CAGGS],
    );
    const caggs = present.rows.map((r) => r.view_name);
    if (!sizes.rows.length && !caggs.length) {
      console.log('No legacy tables left.');
      return;
    }
    console.log('Legacy objects:');
    for (const c of caggs) console.log(`  continuous aggregate ${c}`);
    for (const r of sizes.rows) console.log(`  table ${r.name} (${r.size ?? 'unknown size'})`);
    if (!yes) {
      console.log('\nNothing dropped. Re-run with --yes to drop them permanently.');
      process.exitCode = 1;
      return;
    }
    for (const c of caggs) await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${c} CASCADE`);
    for (const r of sizes.rows) await client.query(`DROP TABLE IF EXISTS ${r.name} CASCADE`);
    console.log('Dropped.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('legacy:drop failed:', err);
  process.exit(1);
});
