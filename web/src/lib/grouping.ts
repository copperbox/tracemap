import type { Status, Topology, TopologyEdge, TopologyService } from '../api/types';
import { worst } from './status';

/**
 * Transforms the raw topology into the graph actually rendered on the map.
 * When team grouping is on, every service owned by a collapsed team folds
 * into one "meganode"; edges crossing a group boundary are aggregated.
 * Services without a team (often external dependencies) stay individual
 * until someone assigns them to a group.
 */

export interface GraphNode {
  key: string; // service id, or "group:<teamId>"
  kind: 'service' | 'group';
  serviceId?: string;
  teamId: number | null;
  label: string;
  type: string; // service type, or 'group'
  status: Status;
  rps: number;
  p95: number | null;
  errPct: number;
  stale: boolean;
  isExternal: boolean;
  memberIds: string[]; // group members (empty for plain services)
  service?: TopologyService;
}

export interface GraphEdge {
  key: string; // "<sourceKey>=><targetKey>"
  sourceKey: string;
  targetKey: string;
  status: Status;
  rps: number;
  p95: number | null;
  errPct: number;
  stale: boolean;
  confidence: number;
  samples: number;
  underlying: TopologyEdge[];
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeKeyOf: (serviceId: string) => string;
}

export function groupKey(teamId: number): string {
  return `group:${teamId}`;
}

export function buildGraph(
  topo: Topology,
  opts: { groupByTeam: boolean; expandedTeams: number[] },
): Graph {
  const teamName = new Map(topo.teams.map((t) => [t.id, t.name]));
  const collapsed = (svc: TopologyService): boolean =>
    opts.groupByTeam &&
    svc.teamId != null &&
    teamName.has(svc.teamId) &&
    !opts.expandedTeams.includes(svc.teamId);

  const byId = new Map(topo.services.map((s) => [s.id, s]));
  const nodeKeyOf = (serviceId: string): string => {
    const svc = byId.get(serviceId);
    if (!svc) return serviceId;
    return collapsed(svc) ? groupKey(svc.teamId as number) : serviceId;
  };

  const nodes: GraphNode[] = [];
  const groups = new Map<number, TopologyService[]>();

  for (const svc of topo.services) {
    if (collapsed(svc)) {
      const arr = groups.get(svc.teamId as number) ?? [];
      arr.push(svc);
      groups.set(svc.teamId as number, arr);
    } else {
      nodes.push({
        key: svc.id,
        kind: 'service',
        serviceId: svc.id,
        teamId: svc.teamId,
        label: svc.name,
        type: svc.type,
        status: svc.status,
        rps: svc.metrics.rps,
        p95: svc.metrics.p95,
        errPct: svc.metrics.errPct,
        stale: svc.metrics.stale,
        isExternal: svc.isExternal,
        memberIds: [],
        service: svc,
      });
    }
  }

  for (const [teamId, members] of groups) {
    const rps = members.reduce((a, m) => a + m.metrics.rps, 0);
    const errW = members.reduce((a, m) => a + (m.metrics.errPct / 100) * m.metrics.rps, 0);
    const p95s = members.map((m) => m.metrics.p95).filter((v): v is number => v != null);
    nodes.push({
      key: groupKey(teamId),
      kind: 'group',
      teamId,
      label: teamName.get(teamId) ?? `team ${teamId}`,
      type: 'group',
      status: worst(members.map((m) => m.status)),
      rps,
      p95: p95s.length ? Math.max(...p95s) : null,
      errPct: rps > 0 ? (errW / rps) * 100 : 0,
      stale: members.every((m) => m.metrics.stale),
      isExternal: false,
      memberIds: members.map((m) => m.id),
    });
  }

  const edgeAgg = new Map<string, GraphEdge>();
  for (const e of topo.edges) {
    const sourceKey = nodeKeyOf(e.source);
    const targetKey = nodeKeyOf(e.target);
    if (sourceKey === targetKey) continue; // internal to a group
    const key = `${sourceKey}=>${targetKey}`;
    const cur = edgeAgg.get(key);
    if (!cur) {
      edgeAgg.set(key, {
        key,
        sourceKey,
        targetKey,
        status: e.status,
        rps: e.metrics.rps,
        p95: e.metrics.p95,
        errPct: e.metrics.errPct,
        stale: e.metrics.stale,
        confidence: e.confidence,
        samples: e.samples,
        underlying: [e],
      });
    } else {
      const rps = cur.rps + e.metrics.rps;
      const errW = (cur.errPct / 100) * cur.rps + (e.metrics.errPct / 100) * e.metrics.rps;
      cur.rps = rps;
      cur.errPct = rps > 0 ? (errW / rps) * 100 : 0;
      cur.p95 =
        cur.p95 == null ? e.metrics.p95 : e.metrics.p95 == null ? cur.p95 : Math.max(cur.p95, e.metrics.p95);
      cur.status = worst([cur.status, e.status]);
      cur.stale = cur.stale && e.metrics.stale;
      cur.confidence = Math.min(cur.confidence, e.confidence);
      cur.samples += e.samples;
      cur.underlying.push(e);
    }
  }

  return { nodes, edges: [...edgeAgg.values()], nodeKeyOf };
}
