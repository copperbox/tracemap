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
 * How a build mapped the topology onto the graph. The next build reuses it
 * when the structure is the same (the usual case: a live update changes
 * numbers and statuses, not which services and edges exist), so it does not
 * rebuild a lookup map and a key string for every service and edge.
 *
 * It holds ids and indices only, never topology objects: a graph's nodeKeyOf
 * closes over its plan and outlives the build.
 */
interface Plan {
  mergedTeams: readonly number[];
  teamGrouping: boolean;
  teamIds: number[];
  teamNames: string[];
  svcIds: string[];
  svcTeams: (number | null)[];
  /** Per service: the index of its own node, or -(g + 1) when it is folded into group `g`. */
  svcNode: Int32Array;
  /** Per group: its team id and the index of its node. */
  groupTeams: number[];
  groupNode: number[];
  edgeSources: string[];
  edgeTargets: string[];
  /** Per topology edge: the index of the graph edge it feeds, or -1 when both ends are in one group. */
  edgeIndex: Int32Array;
  /** Per graph edge. */
  keys: string[];
  sourceKeys: string[];
  targetKeys: string[];
}

const plans = new WeakMap<Graph, Plan>();

function nodeKeyLookup(plan: Plan): (serviceId: string) => string {
  // only folded services map to another key; built on first use
  let folded: Map<string, string> | null = null;
  return (serviceId) => {
    if (!folded) {
      folded = new Map();
      for (let i = 0; i < plan.svcIds.length; i++) {
        const t = plan.svcNode[i];
        if (t < 0) folded.set(plan.svcIds[i], groupKey(plan.groupTeams[-t - 1]));
      }
    }
    return folded.get(serviceId) ?? serviceId;
  };
}

function serviceNode(svc: TopologyService, teamName: string | null): GraphNode {
  return {
    key: svc.id,
    kind: 'service',
    serviceId: svc.id,
    teamId: svc.teamId,
    teamName,
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
  };
}

function groupNode(teamId: number, label: string, members: TopologyService[]): GraphNode {
  const rps = members.reduce((a, m) => a + m.metrics.rps, 0);
  const errW = members.reduce((a, m) => a + (m.metrics.errPct / 100) * m.metrics.rps, 0);
  const p95s = members.map((m) => m.metrics.p95).filter((v): v is number => v != null);
  const group: GraphNode = {
    key: groupKey(teamId),
    kind: 'group',
    teamId,
    teamName: null,
    label,
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
  return group;
}

/** One graph edge from the topology edges between the same two nodes. */
function graphEdge(key: string, sourceKey: string, targetKey: string, list: TopologyEdge[]): GraphEdge {
  const first = list[0];
  const cur: GraphEdge = {
    key,
    sourceKey,
    targetKey,
    status: first.status,
    rps: first.metrics.rps,
    p95: first.metrics.p95,
    errPct: first.metrics.errPct,
    stale: first.metrics.stale,
    confidence: first.confidence,
    samples: first.samples,
    underlying: list,
  };
  for (let i = 1; i < list.length; i++) {
    const e = list[i];
    const rps = cur.rps + e.metrics.rps;
    const errW = (cur.errPct / 100) * cur.rps + (e.metrics.errPct / 100) * e.metrics.rps;
    cur.rps = rps;
    cur.errPct = rps > 0 ? (errW / rps) * 100 : 0;
    cur.p95 = cur.p95 == null ? e.metrics.p95 : e.metrics.p95 == null ? cur.p95 : Math.max(cur.p95, e.metrics.p95);
    cur.status = worst([cur.status, e.status]);
    cur.stale = cur.stale && e.metrics.stale;
    cur.confidence = Math.min(cur.confidence, e.confidence);
    cur.samples += e.samples;
  }
  return cur;
}

/** Lay out the mapping from scratch: which node each service becomes, which graph edge each edge feeds. */
function makePlan(topo: Topology, mergedTeams: readonly number[], teamGrouping: boolean): Plan {
  const known = new Set(topo.teams.map((t) => t.id));
  // With grouping off, no team ever collapses into a meganode -- services stay
  // individual and merge state is ignored until grouping is turned back on.
  const merged = new Set(mergedTeams);
  const folds = (svc: TopologyService): boolean =>
    teamGrouping && svc.teamId != null && known.has(svc.teamId) && merged.has(svc.teamId);

  const n = topo.services.length;
  const svcNode = new Int32Array(n);
  const groupTeams: number[] = [];
  const groupOfTeam = new Map<number, number>();
  const folded = new Map<string, string>();
  let nodeCount = 0;
  for (let i = 0; i < n; i++) {
    const svc = topo.services[i];
    if (!folds(svc)) {
      svcNode[i] = nodeCount++;
      continue;
    }
    const teamId = svc.teamId as number;
    let g = groupOfTeam.get(teamId);
    if (g === undefined) {
      g = groupTeams.length;
      groupTeams.push(teamId);
      groupOfTeam.set(teamId, g);
    }
    svcNode[i] = -(g + 1);
    folded.set(svc.id, groupKey(teamId));
  }
  // group nodes follow the service nodes, in the order their first member appears
  const groupNode = groupTeams.map((_, g) => nodeCount + g);

  const edgeIndex = new Int32Array(topo.edges.length);
  const keys: string[] = [];
  const sourceKeys: string[] = [];
  const targetKeys: string[] = [];
  const indexOfKey = new Map<string, number>();
  for (let j = 0; j < topo.edges.length; j++) {
    const e = topo.edges[j];
    const sourceKey = folded.get(e.source) ?? e.source;
    const targetKey = folded.get(e.target) ?? e.target;
    if (sourceKey === targetKey) {
      edgeIndex[j] = -1; // internal to a group
      continue;
    }
    const key = `${sourceKey}=>${targetKey}`;
    let k = indexOfKey.get(key);
    if (k === undefined) {
      k = keys.length;
      keys.push(key);
      sourceKeys.push(sourceKey);
      targetKeys.push(targetKey);
      indexOfKey.set(key, k);
    }
    edgeIndex[j] = k;
  }
  return {
    mergedTeams,
    teamGrouping,
    teamIds: topo.teams.map((t) => t.id),
    teamNames: topo.teams.map((t) => t.name),
    svcIds: topo.services.map((s) => s.id),
    svcTeams: topo.services.map((s) => s.teamId),
    svcNode,
    groupTeams,
    groupNode,
    edgeSources: topo.edges.map((e) => e.source),
    edgeTargets: topo.edges.map((e) => e.target),
    edgeIndex,
    keys,
    sourceKeys,
    targetKeys,
  };
}

/** Whether `plan` still describes this topology: same teams, services, edges and merge state. */
function planFits(plan: Plan, topo: Topology, mergedTeams: readonly number[], teamGrouping: boolean): boolean {
  if (plan.teamGrouping !== teamGrouping) return false;
  if (plan.mergedTeams !== mergedTeams && !sameList(plan.mergedTeams, mergedTeams)) return false;
  const { teams, services, edges } = topo;
  if (teams.length !== plan.teamIds.length || services.length !== plan.svcIds.length) return false;
  if (edges.length !== plan.edgeSources.length) return false;
  for (let i = 0; i < teams.length; i++) {
    if (teams[i].id !== plan.teamIds[i] || teams[i].name !== plan.teamNames[i]) return false;
  }
  for (let i = 0; i < services.length; i++) {
    if (services[i].id !== plan.svcIds[i] || services[i].teamId !== plan.svcTeams[i]) return false;
  }
  for (let j = 0; j < edges.length; j++) {
    if (edges[j].source !== plan.edgeSources[j] || edges[j].target !== plan.edgeTargets[j]) return false;
  }
  return true;
}

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
  const prev = opts.prev ?? null;
  const teamGrouping = opts.teamGrouping ?? true;
  const prevPlan = prev ? plans.get(prev) : undefined;
  // Same structure as last time: nodes and edges line up with the previous
  // graph by index. Otherwise they are matched by key.
  const aligned = prev != null && prevPlan != null && planFits(prevPlan, topo, opts.mergedTeams, teamGrouping);
  const plan = aligned ? (prevPlan as Plan) : makePlan(topo, opts.mergedTeams, teamGrouping);
  const prevNodeAt = aligned
    ? (i: number): GraphNode | undefined => (prev as Graph).nodes[i]
    : (() => {
        const byKey = new Map((prev?.nodes ?? []).map((n) => [n.key, n]));
        return (_i: number, key: string): GraphNode | undefined => byKey.get(key);
      })();
  const prevEdgeAt = aligned
    ? (k: number): GraphEdge | undefined => (prev as Graph).edges[k]
    : (() => {
        const byKey = new Map((prev?.edges ?? []).map((e) => [e.key, e]));
        return (_k: number, key: string): GraphEdge | undefined => byKey.get(key);
      })();

  const teamName = new Map<number, string>();
  for (let i = 0; i < plan.teamIds.length; i++) teamName.set(plan.teamIds[i], plan.teamNames[i]);
  const nameOfTeam = (teamId: number | null): string | null => (teamId == null ? null : (teamName.get(teamId) ?? null));

  const nodes = new Array<GraphNode>(topo.services.length - countFolded(plan) + plan.groupTeams.length);
  const members: TopologyService[][] = plan.groupTeams.map(() => []);
  for (let i = 0; i < topo.services.length; i++) {
    const svc = topo.services[i];
    const at = plan.svcNode[i];
    if (at < 0) {
      members[-at - 1].push(svc);
      continue;
    }
    const was = prevNodeAt(at, svc.id);
    const name = nameOfTeam(svc.teamId);
    nodes[at] = was && was.service === svc && was.teamName === name ? was : serviceNode(svc, name);
  }
  for (let g = 0; g < plan.groupTeams.length; g++) {
    const teamId = plan.groupTeams[g];
    const label = teamName.get(teamId) ?? `team ${teamId}`;
    const was = prevNodeAt(plan.groupNode[g], groupKey(teamId));
    const wasMembers = was ? groupMembers.get(was) : undefined;
    nodes[plan.groupNode[g]] =
      was && wasMembers && sameList(wasMembers, members[g]) && was.label === label ? was : groupNode(teamId, label, members[g]);
  }

  // bucket the raw edges per rendered edge first, so an unchanged bucket can
  // reuse last build's aggregate
  const lists = new Array<TopologyEdge[] | undefined>(plan.keys.length);
  for (let j = 0; j < topo.edges.length; j++) {
    const k = plan.edgeIndex[j];
    if (k < 0) continue;
    const list = lists[k];
    if (list) list.push(topo.edges[j]);
    else lists[k] = [topo.edges[j]];
  }
  const edges = new Array<GraphEdge>(plan.keys.length);
  for (let k = 0; k < plan.keys.length; k++) {
    const list = lists[k] as TopologyEdge[];
    const was = prevEdgeAt(k, plan.keys[k]);
    edges[k] = was && sameList(was.underlying, list) ? was : graphEdge(plan.keys[k], plan.sourceKeys[k], plan.targetKeys[k], list);
  }

  if (prev && sameList(prev.nodes, nodes) && sameList(prev.edges, edges)) {
    plans.set(prev, plan);
    return prev;
  }
  const graph: Graph = {
    nodes: prev && sameList(prev.nodes, nodes) ? prev.nodes : nodes,
    edges: prev && sameList(prev.edges, edges) ? prev.edges : edges,
    // a build that kept the structure keeps the lookup too
    nodeKeyOf: aligned ? (prev as Graph).nodeKeyOf : nodeKeyLookup(plan),
  };
  plans.set(graph, plan);
  return graph;
}

function countFolded(plan: Plan): number {
  let n = 0;
  for (let i = 0; i < plan.svcNode.length; i++) if (plan.svcNode[i] < 0) n++;
  return n;
}
