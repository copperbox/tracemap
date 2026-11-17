/**
 * Live read side: the shared snapshot, the SSE hub and the rollup reader,
 * built once per process. index.ts calls startLive() before the API listens
 * and stopLive() before it closes.
 */
import { aliases } from '../api/aliases.js';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { getPipeline } from '../pipeline/index.js';
import { RollupReader, SqlRowSource } from '../rollup/read.js';
import { LiveSnapshot } from './snapshot.js';
import { SseHub, formatEvent } from './sse.js';

/** SNAPSHOT_INTERVAL_MS (config.snapshotIntervalMs): how often the live snapshot (and frame) is rebuilt. */
export const SNAPSHOT_INTERVAL_MS = config.snapshotIntervalMs;

export interface Live {
  snapshot: LiveSnapshot;
  hub: SseHub;
  reader: RollupReader;
  rows: SqlRowSource;
}

let instance: Live | null = null;

/** Process-wide read side, built on first use. */
export function getLive(): Live {
  if (instance) return instance;
  const rows = new SqlRowSource(query);
  // Newest 1m rows can be one flush behind now.
  const reader = new RollupReader(rows, { lagMs: config.rollupFlushMs });
  const snapshot = new LiveSnapshot(getPipeline(), query, aliases, reader, {
    intervalMs: SNAPSHOT_INTERVAL_MS,
    liveWindowMinutes: config.liveWindowMinutes,
  });
  const hub = new SseHub();
  snapshot.onPublish((snap, structureChanged) => {
    if (!hub.size) return;
    // One chunk per publish, so a structure notice is never split from its frame notice.
    const metrics = formatEvent('metrics', { seq: snap.seq, structureVersion: snap.structure.version });
    hub.broadcast(structureChanged ? formatEvent('structure', { version: snap.structure.version }) + metrics : metrics);
  });
  instance = { snapshot, hub, reader, rows };
  return instance;
}

export async function startLive(): Promise<void> {
  await getLive().snapshot.start();
}

export async function stopLive(): Promise<void> {
  if (!instance) return;
  instance.hub.close();
  await instance.snapshot.stop();
}
