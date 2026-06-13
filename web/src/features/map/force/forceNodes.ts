/**
 * Builds the inputs the d3-force simulation consumes from the rendered graph:
 * one circular node per service (radius scaled by traffic) tagged with its
 * detected community, and one link per dependency edge.
 */

import type { Status } from '../../../api/types';
import type { GraphEdge, GraphNode } from '../../../lib/grouping';

export interface ForceNodeInput {
  key: string;
  label: string;
  status: Status;
  type: string;
  isExternal: boolean;
  community: number;
  /** circle radius in world units (drives both drawing and collision). */
  r: number;
}

export interface ForceLinkInput {
  key: string;
  source: string;
  target: string;
}

const R_MIN = 5;
const R_MAX = 26;

/** Node radius from call rate: a gentle log ramp, clamped so quiet and very
 *  busy services stay within a readable size band. */
export function nodeRadius(rps: number): number {
  const r = R_MIN + 5 * Math.log10(1 + Math.max(0, rps));
  return Math.max(R_MIN, Math.min(R_MAX, r));
}

export function buildForceNodes(
  nodes: GraphNode[],
  community: Map<string, number>,
): ForceNodeInput[] {
  return nodes.map((n) => ({
    key: n.key,
    label: n.label,
    status: n.status,
    type: n.type,
    isExternal: n.isExternal,
    community: community.get(n.key) ?? 0,
    r: nodeRadius(n.rps),
  }));
}

export function buildForceLinks(edges: GraphEdge[]): ForceLinkInput[] {
  return edges.map((e) => ({ key: e.key, source: e.sourceKey, target: e.targetKey }));
}
