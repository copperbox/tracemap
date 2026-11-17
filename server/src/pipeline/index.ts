/**
 * Collector pipeline: public surface for the server and the read path.
 *
 * Read side (what the API and live snapshot consume):
 *
 * - getPipeline().liveServices(now?) / liveEdges(now?): per-service and
 *   per-edge aggregates over the last LIVE_WINDOW_MINUTES, held in memory and
 *   counted by THIS collector only. Each entry has n (spans), err (error
 *   spans), sumMs (ms) and a merged Float64Array histogram; `seconds` is the
 *   covered time, so rps = n / seconds. summarize() turns an entry into
 *   rps / p50 / p95 / p99 (ms) / errPct (0..100). Edge keys split with splitEdgeKey().
 * - getPipeline().collectorId: this process's collectors.id (null before
 *   start()). Rows in *_1m tables carry it; other collectors' 1m rows are the
 *   ones with a different id and a recent collectors.heartbeat_at.
 * - getPipeline().stats(): PipelineStats for /api/health. pendingEdgeResolutions
 *   is stats().edges.pendingClients + pendingServers; spansLastMinute is
 *   stats().spans.lastMinute.
 * - TIERS / ROLLUP_KINDS / tableName() / KEPT_TABLES: table names, grains
 *   (ms, epoch aligned) and retention (ms, null = forever). Read 1m rows with
 *   SUM over collector_id. rollup_tier_state(kind, tier).compacted_through
 *   says how far each coarse tier is complete; newer time must come from the
 *   tier below.
 * - Histogram codec (rollup/hist.ts): decode()/decodeInto() a bytea hist,
 *   mergeInto(), quantile().
 * - Id mapping (rollup/schema.ts): uuidToHex()/hexToUuid() for trace ids,
 *   bigintToSpanHex()/spanHexToBigint() for span ids.
 */
import { config } from '../config.js';
import { ingestPool } from '../db/pool.js';
import { registry } from '../otlp/registry.js';
import { Pipeline } from './pipeline.js';

export { Pipeline } from './pipeline.js';
export type { GateResult, IngestResult, JobStats, OverloadReason, PipelineStats } from './pipeline.js';
export { splitEdgeKey, type LiveAggregate, type LiveWindow } from './cells.js';
export { summarize, type Summary } from './summary.js';
export {
  KEPT_TABLES,
  OTHER_ERROR_CODE,
  OTHER_OPERATION,
  ROLLUP_KINDS,
  TIERS,
  tableName,
  tier,
  type KeepReason,
  type RollupKind,
  type RollupKindName,
  type Tier,
  type TierName,
} from '../rollup/tiers.js';
export { decode as decodeHist, decodeInto, mergeInto, newWideHist, quantile } from '../rollup/hist.js';
export { bigintToSpanHex, hexToUuid, spanHexToBigint, uuidToHex } from '../rollup/schema.js';

let instance: Pipeline | null = null;

/**
 * The process-wide pipeline, built on first use from `config`, the ingest
 * pool and the shared service registry. start() is called by index.ts.
 */
export function getPipeline(): Pipeline {
  instance ??= new Pipeline(config, ingestPool, registry);
  return instance;
}
