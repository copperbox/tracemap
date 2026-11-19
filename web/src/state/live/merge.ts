import type {
  LiveMetrics,
  LiveStructure,
  Status,
  Team,
  Topology,
  TopologyEdge,
  TopologyService,
} from '../../api/types';
import { FRAME_FIELDS, FrameError, type MetricsFrame } from './frame';

/**
 * Turns a structure plus a metrics frame into the store's `Topology`, reusing
 * objects from the previous result wherever nothing changed. The map's
 * grouping and memoization key on object identity, so an entity whose values
 * are the same as last frame must come back as the same object, and the arrays
 * come back unchanged when no entity in them changed.
 */

export interface LiveSnapshot {
  structure: LiveStructure;
  topology: Topology;
}

/** Throws FrameError when the frame cannot belong to this structure. */
export function checkFrameMatches(structure: LiveStructure, frame: MetricsFrame): void {
  if (frame.structureVersion !== structure.version) {
    throw new FrameError(`frame is for structure ${frame.structureVersion}, have ${structure.version}`);
  }
  if (frame.nServices !== structure.services.length || frame.nEdges !== structure.edges.length) {
    throw new FrameError(
      `frame has ${frame.nServices}/${frame.nEdges} entities, structure ${structure.services.length}/${structure.edges.length}`,
    );
  }
}

/** Status in flag bits 1-2. 3 is unassigned; show it as critical rather than hide it. */
export function flagStatus(flags: number): Status {
  const s = (flags >> 1) & 3;
  return s === 0 ? 'ok' : s === 1 ? 'warn' : 'crit';
}

const orNull = (v: number): number | null => (Number.isNaN(v) ? null : v);
// rps and errPct are non-null in LiveMetrics; a null there means "no traffic".
const orZero = (v: number): number => (Number.isNaN(v) ? 0 : v);

/** True when `m` already holds the frame's values for entity `i`. */
function sameMetrics(m: LiveMetrics, vals: Float32Array, i: number, stale: boolean): boolean {
  const o = i * FRAME_FIELDS;
  return (
    m.stale === stale &&
    m.rps === orZero(vals[o]) &&
    m.p50 === orNull(vals[o + 1]) &&
    m.p95 === orNull(vals[o + 2]) &&
    m.p99 === orNull(vals[o + 3]) &&
    m.errPct === orZero(vals[o + 4])
  );
}

function readMetrics(vals: Float32Array, i: number, stale: boolean): LiveMetrics {
  const o = i * FRAME_FIELDS;
  return {
    rps: orZero(vals[o]),
    p50: orNull(vals[o + 1]),
    p95: orNull(vals[o + 2]),
    p99: orNull(vals[o + 3]),
    errPct: orZero(vals[o + 4]),
    stale,
  };
}

function sameServiceMeta(a: TopologyService, b: LiveStructure['services'][number]): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.description === b.description &&
    a.type === b.type &&
    a.teamId === b.teamId &&
    a.runtime === b.runtime &&
    a.region === b.region &&
    a.isExternal === b.isExternal &&
    a.sloTarget === b.sloTarget &&
    a.sloAttain === b.sloAttain &&
    a.firstSeen === b.firstSeen &&
    a.lastSeen === b.lastSeen
  );
}

function sameEdgeMeta(a: TopologyEdge, b: LiveStructure['edges'][number], source: string, target: string): boolean {
  return (
    a.source === source &&
    a.target === target &&
    a.firstSeen === b.firstSeen &&
    a.lastSeen === b.lastSeen &&
    a.samples === b.samples &&
    a.manual === b.manual &&
    a.confidence === b.confidence
  );
}

function sameTeams(a: Team[], b: Team[]): boolean {
  return a.length === b.length && a.every((t, i) => t.id === b[i].id && t.name === b[i].name);
}

/**
 * Merge `frame` onto `structure`. `prev` is the last snapshot: when it holds
 * the same structure object, entities line up by index (the common case, one
 * frame every couple of seconds); after a structure change they are matched by
 * id. The caller must have run checkFrameMatches.
 */
export function mergeFrame(
  structure: LiveStructure,
  frame: MetricsFrame,
  prev: LiveSnapshot | null,
): LiveSnapshot {
  const generatedAt = new Date(frame.generatedAtMs).toISOString();
  const sameStructure = prev?.structure === structure;
  const prevTopo = prev?.topology ?? null;

  // Services.
  const prevSvcById =
    prevTopo && !sameStructure ? new Map(prevTopo.services.map((s) => [s.id, s])) : null;
  let svcChanged = !sameStructure;
  const services: TopologyService[] = new Array(structure.services.length);
  for (let i = 0; i < structure.services.length; i++) {
    const meta = structure.services[i];
    const flags = frame.serviceFlags[i];
    const stale = (flags & 1) === 1;
    const status = flagStatus(flags);
    const old = sameStructure ? prevTopo!.services[i] : prevSvcById?.get(meta.id);
    const metaOk = old != null && (sameStructure || sameServiceMeta(old, meta));
    if (old && metaOk && old.status === status && sameMetrics(old.metrics, frame.services, i, stale)) {
      services[i] = old;
      continue;
    }
    svcChanged = true;
    services[i] =
      old && metaOk
        ? { ...old, status, metrics: readMetrics(frame.services, i, stale) }
        : {
            id: meta.id,
            name: meta.name,
            description: meta.description,
            type: meta.type,
            teamId: meta.teamId,
            runtime: meta.runtime,
            region: meta.region,
            isExternal: meta.isExternal,
            sloTarget: meta.sloTarget,
            sloAttain: meta.sloAttain,
            firstSeen: meta.firstSeen,
            lastSeen: meta.lastSeen,
            status,
            metrics: readMetrics(frame.services, i, stale),
          };
  }
  // A structure change that reused every object in the same order still
  // keeps the old array.
  if (svcChanged && prevTopo && !sameStructure && sameList(prevTopo.services, services)) svcChanged = false;

  // Edges.
  const prevEdgeByKey =
    prevTopo && !sameStructure ? new Map(prevTopo.edges.map((e) => [`${e.source}\u0000${e.target}`, e])) : null;
  let edgeChanged = !sameStructure;
  const edges: TopologyEdge[] = new Array(structure.edges.length);
  for (let i = 0; i < structure.edges.length; i++) {
    const meta = structure.edges[i];
    const source = structure.services[meta.s]?.id;
    const target = structure.services[meta.t]?.id;
    if (source == null || target == null) throw new FrameError(`edge ${i} points outside services`);
    const flags = frame.edgeFlags[i];
    const stale = (flags & 1) === 1;
    const status = flagStatus(flags);
    const old = sameStructure ? prevTopo!.edges[i] : prevEdgeByKey?.get(`${source}\u0000${target}`);
    const metaOk = old != null && (sameStructure || sameEdgeMeta(old, meta, source, target));
    if (old && metaOk && old.status === status && sameMetrics(old.metrics, frame.edges, i, stale)) {
      edges[i] = old;
      continue;
    }
    edgeChanged = true;
    edges[i] =
      old && metaOk
        ? { ...old, status, metrics: readMetrics(frame.edges, i, stale) }
        : {
            source,
            target,
            firstSeen: meta.firstSeen,
            lastSeen: meta.lastSeen,
            samples: meta.samples,
            manual: meta.manual,
            confidence: meta.confidence,
            status,
            metrics: readMetrics(frame.edges, i, stale),
          };
  }
  if (edgeChanged && prevTopo && !sameStructure && sameList(prevTopo.edges, edges)) edgeChanged = false;

  const teams =
    prevTopo && (sameStructure || sameTeams(prevTopo.teams, structure.teams)) ? prevTopo.teams : structure.teams;

  return {
    structure,
    topology: {
      services: svcChanged || !prevTopo ? services : prevTopo.services,
      edges: edgeChanged || !prevTopo ? edges : prevTopo.edges,
      teams,
      generatedAt,
    },
  };
}

function sameList<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The header's "ingesting" indicator: some service is live and taking traffic. */
export function isIngesting(t: Topology): boolean {
  return t.services.some((s) => !s.metrics.stale && s.metrics.rps > 0);
}
