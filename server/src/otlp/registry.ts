import { query } from '../db/pool.js';
import type { ServiceType } from './infer.js';

interface KnownService {
  isExternal: boolean;
  lastSeenWrite: number;
}

/**
 * In-memory view of the service catalog and alias table, shared by the OTLP
 * ingest path (hot) and the management API (which invalidates it on writes).
 */
export class ServiceRegistry {
  private known = new Map<string, KnownService>();
  private aliases = new Map<string, string>();
  private lastSeenThrottleMs = 30_000;

  async load(): Promise<void> {
    const svc = await query<{ id: string; is_external: boolean }>(
      'SELECT id, is_external FROM services',
    );
    this.known.clear();
    for (const row of svc.rows) {
      this.known.set(row.id, { isExternal: row.is_external, lastSeenWrite: 0 });
    }
    await this.reloadAliases();
  }

  async reloadAliases(): Promise<void> {
    const res = await query<{ alias: string; service_id: string }>(
      'SELECT alias, service_id FROM service_aliases',
    );
    this.aliases = new Map(res.rows.map((r) => [r.alias, r.service_id]));
  }

  /** Canonical service id for an incoming telemetry name. */
  resolve(name: string): string {
    return this.aliases.get(name) ?? name;
  }

  /** Is this id a service we have seen own telemetry from? */
  isInternal(id: string): boolean {
    const canonical = this.resolve(id);
    const k = this.known.get(canonical);
    return !!k && !k.isExternal;
  }

  has(id: string): boolean {
    return this.known.has(id);
  }

  /**
   * Make sure a service row exists and its last_seen is fresh.
   * Inserts immediately on first sight; throttles last_seen updates after.
   */
  async ensure(
    id: string,
    fields: {
      type?: ServiceType;
      runtime?: string | null;
      region?: string | null;
      isExternal: boolean;
    },
    now = Date.now(),
  ): Promise<void> {
    const existing = this.known.get(id);
    if (existing) {
      // A service that reports its own telemetry is authoritative over an
      // earlier externally-inferred placeholder.
      if (existing.isExternal && !fields.isExternal) {
        await query(
          `UPDATE services SET is_external = FALSE, type = $2,
                  runtime = COALESCE($3, runtime), region = COALESCE($4, region), last_seen = now()
           WHERE id = $1`,
          [id, fields.type ?? 'service', fields.runtime ?? null, fields.region ?? null],
        );
        existing.isExternal = false;
        existing.lastSeenWrite = now;
        return;
      }
      if (now - existing.lastSeenWrite > this.lastSeenThrottleMs) {
        existing.lastSeenWrite = now;
        await query('UPDATE services SET last_seen = now() WHERE id = $1', [id]);
      }
      return;
    }
    this.known.set(id, { isExternal: fields.isExternal, lastSeenWrite: now });
    await query(
      `INSERT INTO services (id, type, runtime, region, is_external)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET last_seen = now()`,
      [id, fields.type ?? 'service', fields.runtime ?? null, fields.region ?? null, fields.isExternal],
    );
  }
}

export const registry = new ServiceRegistry();
