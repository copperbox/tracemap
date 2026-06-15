export type Status = 'ok' | 'warn' | 'crit';

export interface LiveMetrics {
  rps: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  errPct: number;
  stale: boolean;
}

export interface TopologyService {
  id: string;
  name: string;
  description: string | null;
  type: string;
  teamId: number | null;
  runtime: string | null;
  region: string | null;
  isExternal: boolean;
  sloTarget: number;
  sloAttain: number | null;
  firstSeen: string;
  lastSeen: string;
  status: Status;
  metrics: LiveMetrics;
}

export interface TopologyEdge {
  source: string;
  target: string;
  firstSeen: string;
  lastSeen: string;
  samples: number;
  manual: boolean;
  confidence: number;
  status: Status;
  metrics: LiveMetrics;
}

export interface Team {
  id: number;
  name: string;
}

export interface Topology {
  services: TopologyService[];
  edges: TopologyEdge[];
  teams: Team[];
  generatedAt: string;
}

export interface ServiceListItem {
  id: string;
  name: string;
  type: string;
  teamId: number | null;
  runtime: string | null;
  isExternal: boolean;
  sloTarget: number;
  sloAttain: number | null;
  lastSeen: string;
  status: Status;
  rps: number;
  p95: number | null;
  errPct: number;
  spark: number[];
}

export interface ServiceList {
  edgeCount: number;
  services: ServiceListItem[];
}

export interface SeriesPoint {
  t: string;
  rps: number | null;
  errPct: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface NeighborEdge {
  source: string;
  target: string;
  direction: 'upstream' | 'downstream';
  otherId: string;
  samples: number;
  manual: boolean;
  firstSeen: string;
  confidence: number;
  rps: number;
  p95: number | null;
  errPct: number;
  status: Status;
}

export interface ServiceDetail {
  service: {
    id: string;
    name: string;
    description: string | null;
    type: string;
    teamId: number | null;
    teamName: string | null;
    runtime: string | null;
    region: string | null;
    isExternal: boolean;
    sloTarget: number;
    sloAttain: number | null;
    firstSeen: string;
    lastSeen: string;
    status: Status;
  };
  range: { from: string; to: string; bucketSeconds: number };
  kpis: {
    rps: number;
    p50: number | null;
    p95: number | null;
    p99: number | null;
    errPct: number;
    liveErrPct: number;
  };
  series: SeriesPoint[];
  operations: {
    name: string;
    rps: number;
    errPct: number | null;
    p95: number | null;
    p99: number | null;
  }[];
  neighbors: NeighborEdge[];
  /** Duplicate service ids merged into this one; each can be unmerged. */
  aliases: string[];
}

export interface ErrorCount {
  /** Grouping label: exception type, "HTTP 503", queue/db error code, etc. */
  code: string;
  message: string | null;
  count: number;
}

export interface OperationErrors {
  operation: string;
  errorCount: number;
  errors: ErrorCount[];
}

export interface ErrorBreakdown {
  operations: OperationErrors[];
}

export interface TraceListItem {
  traceId: string;
  rootOperation: string;
  rootService: string;
  durationMs: number;
  time: string;
  spanCount: number;
  status: 'ok' | 'error';
}

export interface TraceSpan {
  spanId: string;
  parentSpanId: string | null;
  serviceId: string;
  name: string;
  kind: number;
  startTime: string;
  durationMs: number;
  isError: boolean;
  attrs: Record<string, unknown>;
}

export interface TraceDetail {
  traceId: string;
  spans: TraceSpan[];
}
