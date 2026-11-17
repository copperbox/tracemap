/**
 * Rollup table and tier metadata. The migration (003_curated_storage.sql),
 * the collector's writers, tier compaction and the read path all take table
 * names, grains and retention from here so nobody hard-codes them.
 */

export type TierName = '1m' | '10m' | '1h' | '1d';

export interface Tier {
  name: TierName;
  /** Bucket width in ms. Buckets are aligned to the Unix epoch (UTC). */
  grainMs: number;
  /** How long the tier keeps rows, in ms. null = forever. */
  retentionMs: number | null;
  /** Only the 1m tier has collector_id in its key; reads must sum over it. */
  hasCollectorId: boolean;
  /** Tier this one is compacted from, or null for 1m (written by collectors). */
  source: TierName | null;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Finest to coarsest. */
export const TIERS: readonly Tier[] = [
  { name: '1m', grainMs: MIN, retentionMs: 3 * DAY, hasCollectorId: true, source: null },
  { name: '10m', grainMs: 10 * MIN, retentionMs: 30 * DAY, hasCollectorId: false, source: '1m' },
  { name: '1h', grainMs: HOUR, retentionMs: 395 * DAY, hasCollectorId: false, source: '10m' },
  { name: '1d', grainMs: DAY, retentionMs: null, hasCollectorId: false, source: '1h' },
];

export function tier(name: TierName): Tier {
  const t = TIERS.find((x) => x.name === name);
  if (!t) throw new Error(`unknown tier ${name}`);
  return t;
}

export type RollupKindName =
  | 'svc_rollup'
  | 'op_rollup'
  | 'edge_rollup'
  | 'edge_op_rollup'
  | 'svc_error_rollup'
  | 'edge_error_rollup';

/** Which value columns a kind carries. */
export type RollupValueShape =
  /** n, err, sum_ms (float8), hist (bytea, see hist.ts) */
  | 'red'
  /** n, err */
  | 'count'
  /** n, sample_trace_id (uuid, nullable): an example kept trace for this signature */
  | 'error';

export interface RollupKind {
  kind: RollupKindName;
  /** Key columns after bucket (and collector_id at 1m), all text NOT NULL. */
  keys: readonly string[];
  shape: RollupValueShape;
}

/**
 * Six rollup kinds, each stored at every tier as `<kind>_<tier>`.
 *
 * - svc/op: request-handling spans (SERVER, CONSUMER or trace root) a service handled.
 * - edge/edge_op/edge_error: the caller's client span per resolved dependency.
 * - svc_error: error request-handling spans by signature (code, message).
 *
 * n and err are span counts. sum_ms is the sum of durations in ms.
 */
export const ROLLUP_KINDS: readonly RollupKind[] = [
  { kind: 'svc_rollup', keys: ['service_id'], shape: 'red' },
  { kind: 'op_rollup', keys: ['service_id', 'operation'], shape: 'red' },
  { kind: 'edge_rollup', keys: ['source_id', 'target_id'], shape: 'red' },
  { kind: 'edge_op_rollup', keys: ['source_id', 'target_id', 'operation'], shape: 'count' },
  { kind: 'svc_error_rollup', keys: ['service_id', 'operation', 'code', 'message'], shape: 'error' },
  {
    kind: 'edge_error_rollup',
    keys: ['source_id', 'target_id', 'operation', 'code', 'message'],
    shape: 'error',
  },
];

export function rollupKind(kind: RollupKindName): RollupKind {
  const k = ROLLUP_KINDS.find((x) => x.kind === kind);
  if (!k) throw new Error(`unknown rollup kind ${kind}`);
  return k;
}

/** Physical table name, e.g. tableName('svc_rollup', '10m') = 'svc_rollup_10m'. */
export function tableName(kind: RollupKindName, tierName: TierName): string {
  return `${kind}_${tierName}`;
}

/** Value columns stored for a shape, in table order. */
export function valueColumns(shape: RollupValueShape): readonly string[] {
  switch (shape) {
    case 'red':
      return ['n', 'err', 'sum_ms', 'hist'];
    case 'count':
      return ['n', 'err'];
    case 'error':
      return ['n', 'sample_trace_id'];
  }
}

/** Start of the tier bucket containing `ms`. */
export function bucketStart(ms: number, grainMs: number): number {
  return Math.floor(ms / grainMs) * grainMs;
}

/** Operation name used once a service exceeds its distinct-operation cap. */
export const OTHER_OPERATION = '(other)';

/** Error code used once a service exceeds its distinct-signature cap. */
export const OTHER_ERROR_CODE = '(other)';

/** Error messages are truncated to this many characters before they become a key. */
export const ERROR_MESSAGE_MAX = 200;

/** Kept-trace tables. Span ids are bigint (two's complement of the 16-hex id), trace ids uuid. */
export const KEPT_TABLES = {
  spans: 'kept_spans',
  traces: 'kept_traces',
  traceServices: 'kept_trace_services',
  /** Retention of all three, ms. */
  retentionMs: 30 * DAY,
} as const;

/** Why a trace was kept. */
export type KeepReason = 'error' | 'slow' | 'baseline';
