import type pg from 'pg';
import { ingestQuery } from '../db/pool.js';
import type { ServiceType } from './infer.js';

interface KnownService {
  isExternal: boolean;
  hasTeam: boolean;
}

export interface ServiceNote {
  type?: ServiceType;
  runtime?: string | null;
  region?: string | null;
  teamName?: string | null;
  isExternal: boolean;
}

type Db = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

export interface CatalogFlushResult {
  upserted: number;
  touched: number;
  edges: number;
}

/**
 * In-memory view of the service catalog and alias table, shared by the OTLP
 * ingest path (hot) and the management API (which reloads it after merges).
 *
 * Ingest only takes notes, synchronously: which services exist, which were
 * seen, which edges were observed. flush() writes them in a few batched
 * statements per interval, so the catalog never costs a query per batch.
 */
export class ServiceRegistry {
  private known = new Map<string, KnownService>();
  private aliases = new Map<string, string>();
  /** Services to insert or update (new, upgraded from external, or gaining a team). */
  private dirty = new Map<string, ServiceNote>();
  /** Services seen since the last flush (for last_seen). */
  private seen = new Set<string>();
  /** Edge observations since the last flush, "source\u0001target" -> count. */
  private edgeCounts = new Map<string, number>();

  constructor(private readonly db: Db = ingestQuery) {}

  async load(): Promise<void> {
    const svc = await this.db('SELECT id, is_external, team_id FROM services');
    this.known.clear();
    for (const row of svc.rows as { id: string; is_external: boolean; team_id: number | null }[]) {
      this.known.set(row.id, { isExternal: row.is_external, hasTeam: row.team_id != null });
    }
    // Notes not yet flushed stay known, so they are not re-noted as new.
    for (const [id, n] of this.dirty) {
      if (!this.known.has(id)) this.known.set(id, { isExternal: n.isExternal, hasTeam: !!n.teamName });
    }
    await this.reloadAliases();
  }

  async reloadAliases(): Promise<void> {
    const res = await this.db('SELECT alias, service_id FROM service_aliases');
    this.aliases = new Map((res.rows as { alias: string; service_id: string }[]).map((r) => [r.alias, r.service_id]));
  }

  /** Canonical service id for an incoming telemetry name. */
  resolve(name: string): string {
    return this.aliases.get(name) ?? name;
  }

  /** Is this id a service we have seen own telemetry from? */
  isInternal(id: string): boolean {
    const k = this.known.get(this.resolve(id));
    return !!k && !k.isExternal;
  }

  has(id: string): boolean {
    return this.known.has(id);
  }

  /**
   * Hot-path shortcut: mark an instrumented service seen and return true when
   * nothing else is needed. False means call note() with full fields (the
   * service is new, still an external placeholder, or may gain a team).
   */
  touch(id: string, hasTeamAttr: boolean): boolean {
    const k = this.known.get(id);
    if (!k || k.isExternal || (hasTeamAttr && !k.hasTeam)) return false;
    this.seen.add(id);
    return true;
  }

  /**
   * Record that a service was seen. Synchronous; the write happens in flush().
   *
   * A service that reports its own telemetry is authoritative over an earlier
   * externally inferred placeholder. `teamName` (from the `team.name` resource
   * attribute) fills a missing team once and never overwrites an assignment,
   * so manual curation stays authoritative.
   */
  note(id: string, fields: ServiceNote): void {
    this.seen.add(id);
    const existing = this.known.get(id);
    if (!existing) {
      this.known.set(id, { isExternal: fields.isExternal, hasTeam: !!fields.teamName });
      this.dirty.set(id, fields);
      return;
    }
    if (existing.isExternal && !fields.isExternal) {
      existing.isExternal = false;
      if (fields.teamName) existing.hasTeam = true;
      this.dirty.set(id, fields);
      return;
    }
    if (fields.teamName && !existing.hasTeam) {
      // Mark now: even if the guarded update matches nothing (a team was set
      // through the API since load), it must not be retried per batch.
      existing.hasTeam = true;
      this.dirty.set(id, { ...fields, isExternal: existing.isExternal });
    }
  }

  /** Record one observation of a learned edge. */
  noteEdge(source: string, target: string): void {
    const k = source + '\u0001' + target;
    this.edgeCounts.set(k, (this.edgeCounts.get(k) ?? 0) + 1);
  }

  /** Notes waiting for flush(). */
  get pending(): { services: number; seen: number; edges: number } {
    return { services: this.dirty.size, seen: this.seen.size, edges: this.edgeCounts.size };
  }

  /**
   * Write pending notes: teams, new/changed services, last_seen for everything
   * seen, and learned edges, one statement each. On failure the notes are put
   * back for the next attempt.
   */
  async flush(): Promise<CatalogFlushResult> {
    const dirty = this.dirty;
    const seen = this.seen;
    const edges = this.edgeCounts;
    this.dirty = new Map();
    this.seen = new Set();
    this.edgeCounts = new Map();
    try {
      if (dirty.size) {
        const teams = [...new Set([...dirty.values()].map((n) => n.teamName?.trim()).filter((t): t is string => !!t))];
        if (teams.length) {
          await this.db(
            'INSERT INTO teams (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING',
            [teams],
          );
        }
        const ids = [...dirty.keys()];
        const notes = [...dirty.values()];
        await this.db(
          `INSERT INTO services (id, type, runtime, region, is_external, team_id)
           SELECT u.id, u.type, u.runtime, u.region, u.ext, t.id
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::bool[], $6::text[])
             AS u(id, type, runtime, region, ext, team)
           LEFT JOIN teams t ON t.name = u.team
           ON CONFLICT (id) DO UPDATE SET
             is_external = services.is_external AND EXCLUDED.is_external,
             type = CASE WHEN services.is_external AND NOT EXCLUDED.is_external
                         THEN EXCLUDED.type ELSE services.type END,
             runtime = CASE WHEN services.is_external AND NOT EXCLUDED.is_external
                            THEN COALESCE(EXCLUDED.runtime, services.runtime) ELSE services.runtime END,
             region = CASE WHEN services.is_external AND NOT EXCLUDED.is_external
                           THEN COALESCE(EXCLUDED.region, services.region) ELSE services.region END,
             team_id = COALESCE(services.team_id, EXCLUDED.team_id),
             last_seen = now()`,
          [
            ids,
            notes.map((n) => n.type ?? 'service'),
            notes.map((n) => n.runtime ?? null),
            notes.map((n) => n.region ?? null),
            notes.map((n) => n.isExternal),
            notes.map((n) => n.teamName?.trim() || null),
          ],
        );
      }
      const touch = [...seen].filter((id) => !dirty.has(id));
      if (touch.length) {
        await this.db('UPDATE services SET last_seen = now() WHERE id = ANY($1::text[])', [touch]);
      }
      if (edges.size) {
        const src: string[] = [];
        const dst: string[] = [];
        const cnt: number[] = [];
        for (const [k, n] of edges) {
          const i = k.indexOf('\u0001');
          src.push(k.slice(0, i));
          dst.push(k.slice(i + 1));
          cnt.push(n);
        }
        // The joins skip edges whose endpoint was merged away meanwhile (FK safety).
        await this.db(
          `INSERT INTO edges (source_id, target_id, sample_count)
           SELECT u.s, u.t, u.n
           FROM unnest($1::text[], $2::text[], $3::bigint[]) AS u(s, t, n)
           JOIN services a ON a.id = u.s
           JOIN services b ON b.id = u.t
           ON CONFLICT (source_id, target_id)
           DO UPDATE SET sample_count = edges.sample_count + EXCLUDED.sample_count, last_seen = now()`,
          [src, dst, cnt],
        );
      }
      return { upserted: dirty.size, touched: touch.length, edges: edges.size };
    } catch (err) {
      for (const [id, n] of dirty) if (!this.dirty.has(id)) this.dirty.set(id, n);
      for (const id of seen) this.seen.add(id);
      for (const [k, n] of edges) this.edgeCounts.set(k, (this.edgeCounts.get(k) ?? 0) + n);
      throw err;
    }
  }
}

export const registry = new ServiceRegistry();
