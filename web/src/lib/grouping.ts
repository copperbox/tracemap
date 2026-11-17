import type { Status, Topology, TopologyEdge, TopologyService } from '../api/types';
import { worst } from './status';

/**
 * Transforms the raw topology into the graph actually rendered on the map.
 * Merging is per-team: every service owned by a merged team folds into one
 * "meganode"; edges crossing a group boundary are aggregated. Unmerged
 * teams keep their individual services (the map draws a team frame around
 * them). Services without a team (often external dependencies) stay
 * individual until someone assigns them to a team.
 */

export interface GraphNode {
  key: string; // service id, or "group:<teamId>"
  kind: 'service' | 'group';
  serviceId?: string;
  teamId: number | null;
  /** Owning team's display name (null for teamless services and group nodes). */
  teamName: string | null;
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

// Member services a group node was built from, so a later build can tell
// whether the group is unchanged without widening GraphNode.
const groupMembers = new WeakMap<GraphNode, TopologyService[]>();

const sameList = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Build the rendered graph. With `prev` (the previous build), every node and
 * edge whose inputs are the same objects as last time is reused as is, and
 * when nothing changed the previous graph itself is returned. The live feed
 * keeps unchanged services and edges identical between frames, so memoized
 * cards and layers downstream only redo the entities that actually moved.
 */
export function buildGraph(
  topo: Topology,
  opts: { mergedTeams: number[]; teamGrouping?: boolean; prev?: Graph | null },
): Graph {
  const prevNodes = new Map((opts.prev?.nodes ?? []).map((n) => [n.key, n]));
  const prevEdges = new Map((opts.prev?.edges ?? []).map((e) => [e.key, e]));
  const teamGrouping = opts.teamGrouping ?? true;
  const teamName = new Map(topo.teams.map((t) => [t.id, t.name]));
  const nameOfTeam = (teamId: number | null): string | null =>
    teamId == null ? null : teamName.get(teamId) ?? null;
  // With grouping off, no team ever collapses into a meganode -- services stay
  // individual and merge state is ignored until grouping is turned back on.
  const collapsed = (svc: TopologyService): boolean =>
    teamGrouping &&
    svc.teamId != null &&
    teamName.has(svc.teamId) &&
    opts.mergedTeams.includes(svc.teamId);

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
      const was = prevNodes.get(svc.id);
      if (was && was.service === svc && was.teamName === nameOfTeam(svc.teamId)) {
        nodes.push(was);
        continue;
      }
      nodes.push({
        key: svc.id,
        kind: 'service',
        serviceId: svc.id,
        teamId: svc.teamId,
        teamName: nameOfTeam(svc.teamId),
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
    const was = prevNodes.get(groupKey(teamId));
    const wasMembers = was ? groupMembers.get(was) : undefined;
    if (was && wasMembers && sameList(wasMembers, members) && was.label === (teamName.get(teamId) ?? `team ${teamId}`)) {
      nodes.push(was);
      continue;
    }
    const rps = members.reduce((a, m) => a + m.metrics.rps, 0);
    const errW = members.reduce((a, m) => a + (m.metrics.errPct / 100) * m.metrics.rps, 0);
    const p95s = members.map((m) => m.metrics.p95).filter((v): v is number => v != null);
    const group: GraphNode = {
      key: groupKey(teamId),
      kind: 'group',
      teamId,
      teamName: null,
      label: teamName.get(teamId) ?? `team ${teamId}`,
      type: 'group',
      status: worst(members.map((m) => m.status)),
      rps,
      p95: p95s.length ? Math.max(...p95s) : null,
      errPct: rps > 0 ? (errW / rps) * 100 : 0,
      stale: members.every((m) => m.metrics.stale),
      isExternal: false,
      memberIds: members.map((m) => m.id),
    };
    groupMembers.set(group, members);
    nodes.push(group);
  }

  // bucket the raw edges per rendered edge first, so an unchanged bucket can
  // reuse last build's aggregate
  const buckets = new Map<string, { sourceKey: string; targetKey: string; list: TopologyEdge[] }>();
  for (const e of topo.edges) {
    const sourceKey = nodeKeyOf(e.source);
    const targetKey = nodeKeyOf(e.target);
    if (sourceKey === targetKey) continue; // internal to a group
    const key = `${sourceKey}=>${targetKey}`;
    const b = buckets.get(key);
    if (b) b.list.push(e);
    else buckets.set(key, { sourceKey, targetKey, list: [e] });
  }

  const edges: GraphEdge[] = [];
  for (const [key, { sourceKey, targetKey, list }] of buckets) {
    const was = prevEdges.get(key);
    if (was && sameList(was.underlying, list)) {
      edges.push(was);
      continue;
    }
    let cur: GraphEdge | null = null;
    for (const e of list) {
      if (!cur) {
        cur = {
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
        };
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
    edges.push(cur as GraphEdge);
  }

  const prev = opts.prev;
  if (prev && sameList(prev.nodes, nodes) && sameList(prev.edges, edges)) return prev;
  return {
    nodes: prev && sameList(prev.nodes, nodes) ? prev.nodes : nodes,
    edges: prev && sameList(prev.edges, edges) ? prev.edges : edges,
    nodeKeyOf,
  };
}
