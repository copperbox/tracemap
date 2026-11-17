/**
 * Seed worker thread: rebuilds the fleet from its config, generates the rows
 * of every node with idx % count === index and writes them on its own
 * connection. Generation, array serialization and the database round trips
 * then run in parallel across workers.
 */
import { parentPort, workerData } from 'node:worker_threads';
import pg from 'pg';
import { buildFleet, type FleetConfig } from './fleet.js';
import { incidentWindows, type Calibration, type IncidentWindow } from './model.js';
import { DbSink } from './dbSink.js';
import { genNode, type LastMinute, type SeedPlan } from './seedGen.js';

export interface SeedWorkerInput {
  fleet: FleetConfig;
  calib: Calibration;
  plan: SeedPlan;
  databaseUrl: string;
  collectorId: number;
  index: number;
  count: number;
  chunkRows: number;
}

export interface SeedWorkerOutput {
  counts: Record<string, number>;
  last: { node: number; last: LastMinute }[];
}

async function run(input: SeedWorkerInput): Promise<SeedWorkerOutput> {
  const fleet = buildFleet(input.fleet);
  const incidents = new Map<number, IncidentWindow[]>();
  for (const w of incidentWindows(fleet, input.plan.anchorMs)) {
    const list = incidents.get(w.node) ?? [];
    list.push(w);
    incidents.set(w.node, list);
  }
  // Seeding is a bulk load: a lost tail after a crash is re-seeded, not lost data.
  const pool = new pg.Pool({ connectionString: input.databaseUrl, max: 2, options: '-c synchronous_commit=off' });
  try {
    const sink = new DbSink(pool, input.collectorId, input.chunkRows);
    const ctx = { fleet, calib: input.calib, plan: input.plan, incidents };
    const last: SeedWorkerOutput['last'] = [];
    let done = 0;
    for (let i = input.index; i < fleet.nodes.length; i += input.count) {
      last.push({ node: i, last: genNode(ctx, i, sink) });
      await sink.drain();
      if (++done % 50 === 0) parentPort?.postMessage({ progress: 50 });
    }
    await sink.finish();
    parentPort?.postMessage({ progress: done % 50 });
    return { counts: sink.counts, last };
  } finally {
    await pool.end();
  }
}

run(workerData as SeedWorkerInput).then(
  (out) => parentPort?.postMessage({ done: out }),
  (err: Error) => parentPort?.postMessage({ error: err.stack ?? err.message }),
);
