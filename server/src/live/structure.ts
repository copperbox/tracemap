/**
 * The live map's structure: which services, edges and teams exist, in the
 * order the metrics frame uses. Versioned so clients refetch it only when it
 * changes.
 *
 * - Order is stable: surviving services keep their relative order, new ones
 *   are appended (sorted by id among themselves). Same for edges.
 * - The version bumps immediately when services, edges, teams or their
 *   metadata change, and at most once per `volatileRefreshMs` when only the
 *   volatile fields (lastSeen, samples, confidence, sloAttain) moved.
 * - Versions start from the process start time in seconds, so a restarted
 *   server never reuses a version a client cached from the previous one.
 */

export interface StructureService {
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
}

export interface StructureEdge {
  /** Indexes into services. */
  s: number;
  t: number;
  firstSeen: string;
  lastSeen: string;
  samples: number;
  manual: boolean;
  confidence: number;
}

export interface LiveStructure {
  version: number;
  generatedAt: string;
  teams: { id: number; name: string }[];
  services: StructureService[];
  edges: StructureEdge[];
}

/** Catalog rows as read from the database (ids canonical). */
export interface CatalogService extends Omit<StructureService, 'sloAttain'> {}

export interface CatalogEdge {
  source: string;
  target: string;
  firstSeen: string;
  lastSeen: string;
  samples: number;
  manual: boolean;
}

export interface Catalog {
  services: CatalogService[];
  edges: CatalogEdge[];
  teams: { id: number; name: string }[];
}

/** Confidence in a learned edge, from its supporting span count. */
export function edgeConfidence(sampleCount: number, manual: boolean): number {
  if (manual) return 100;
  const c = 85 + 2.5 * Math.log10(sampleCount + 10);
  return Math.min(99.9, Math.max(50, Math.round(c * 10) / 10));
}

export const edgeKey = (s: string, t: string): string => s + '\u0001' + t;

/** Keep `prev` order for survivors, append new keys sorted. */
export function stableOrder(prev: readonly string[], next: Iterable<string>): string[] {
  const want = new Set(next);
  const out = prev.filter((k) => want.has(k));
  const have = new Set(out);
  const added = [...want].filter((k) => !have.has(k)).sort();
  return out.concat(added);
}

export interface StructureUpdate {
  structure: LiveStructure;
  changed: boolean;
}

export class StructureTracker {
  private current: LiveStructure | null = null;
  private serviceOrder: string[] = [];
  private edgeOrder: string[] = [];
  private stableSig = '';
  private volatileSig = '';
  private volatileAt = -Infinity;
  private nextVersion: number;

  constructor(
    private readonly volatileRefreshMs = 60_000,
    startMs = Date.now(),
  ) {
    this.nextVersion = Math.floor(startMs / 1000) >>> 0;
  }

  get structure(): LiveStructure | null {
    return this.current;
  }

  /**
   * Feed the latest catalog and SLO numbers. Returns the structure to publish
   * and whether its version changed.
   */
  update(catalog: Catalog, slo: (id: string) => number | null, nowMs: number): StructureUpdate {
    const byId = new Map(catalog.services.map((s) => [s.id, s]));
    const order = stableOrder(this.serviceOrder, byId.keys());
    const index = new Map(order.map((id, i) => [id, i]));
    const edgeById = new Map<string, CatalogEdge>();
    for (const e of catalog.edges) {
      if (e.source === e.target || !index.has(e.source) || !index.has(e.target)) continue;
      edgeById.set(edgeKey(e.source, e.target), e);
    }
    const eOrder = stableOrder(this.edgeOrder, edgeById.keys());
    const teams = [...catalog.teams].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

    const services: StructureService[] = order.map((id) => ({ ...byId.get(id)!, sloAttain: slo(id) }));
    const edges: StructureEdge[] = eOrder.map((k) => {
      const e = edgeById.get(k)!;
      return {
        s: index.get(e.source)!,
        t: index.get(e.target)!,
        firstSeen: e.firstSeen,
        lastSeen: e.lastSeen,
        samples: e.samples,
        manual: e.manual,
        confidence: edgeConfidence(e.samples, e.manual),
      };
    });

    const stableSig = JSON.stringify([
      teams,
      services.map((s) => [s.id, s.name, s.description, s.type, s.teamId, s.runtime, s.region, s.isExternal, s.sloTarget, s.firstSeen]),
      edges.map((e) => [e.s, e.t, e.firstSeen, e.manual]),
    ]);
    const volatileSig = JSON.stringify([
      services.map((s) => [s.lastSeen, s.sloAttain]),
      edges.map((e) => [e.lastSeen, e.samples]),
    ]);

    const structural = this.current == null || stableSig !== this.stableSig;
    const volatileDue = volatileSig !== this.volatileSig && nowMs - this.volatileAt >= this.volatileRefreshMs;
    if (!structural && !volatileDue) return { structure: this.current!, changed: false };

    this.serviceOrder = order;
    this.edgeOrder = eOrder;
    this.stableSig = stableSig;
    this.volatileSig = volatileSig;
    this.volatileAt = nowMs;
    this.current = {
      version: this.nextVersion++ >>> 0,
      generatedAt: new Date(nowMs).toISOString(),
      teams,
      services,
      edges,
    };
    return { structure: this.current, changed: true };
  }
}
