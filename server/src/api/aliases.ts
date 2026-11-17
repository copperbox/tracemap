import type pg from 'pg';

type Db = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

/**
 * Read-time view of service merges. Telemetry recorded before a merge sits
 * under the old id; reads expand a canonical id to itself plus its aliases and
 * map every id they group by back to canonical.
 */
export class AliasMap {
  private toCanon = new Map<string, string>();
  private byCanon = new Map<string, string[]>();

  set(rows: { alias: string; service_id: string }[]): void {
    this.toCanon = new Map(rows.map((r) => [r.alias, r.service_id]));
    this.byCanon = new Map();
    for (const r of rows) {
      const c = this.canonical(r.alias);
      if (c === r.alias) continue;
      const list = this.byCanon.get(c) ?? [];
      list.push(r.alias);
      this.byCanon.set(c, list);
    }
    for (const list of this.byCanon.values()) list.sort();
  }

  async load(db: Db): Promise<void> {
    const res = await db('SELECT alias, service_id FROM service_aliases');
    this.set(res.rows as { alias: string; service_id: string }[]);
  }

  /** The service an id's telemetry belongs to now. Follows short chains defensively. */
  canonical = (id: string): string => {
    let cur = id;
    for (let i = 0; i < 4; i++) {
      const next = this.toCanon.get(cur);
      if (next == null || next === cur) return cur;
      cur = next;
    }
    return cur;
  };

  /** A canonical id plus every id merged into it. */
  expand(id: string): string[] {
    const c = this.canonical(id);
    return [c, ...(this.byCanon.get(c) ?? [])];
  }

  /** Ids merged into this one (empty for most services). */
  aliasesOf(id: string): string[] {
    return this.byCanon.get(id) ?? [];
  }

  get size(): number {
    return this.toCanon.size;
  }
}

export const aliases = new AliasMap();
