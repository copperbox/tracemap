import { describe, expect, it } from 'vitest';
import { beforeConnect, dataTables, decide, describeTarget, type GuardOpts, type Marker, type TargetFacts } from './target.js';

describe('describeTarget', () => {
  it('reads host, port and database from the URL', () => {
    expect(describeTarget('postgres://tracemap:secret@127.0.0.1:5544/tm_scale')).toEqual({ host: '127.0.0.1', port: 5544, database: 'tm_scale' });
    expect(describeTarget('postgresql://u@db.internal/prod')).toEqual({ host: 'db.internal', port: 5432, database: 'prod' });
  });

  it('falls back the way libpq does', () => {
    expect(describeTarget('postgres://alice@db.internal')).toEqual({ host: 'db.internal', port: 5432, database: 'alice' });
    expect(describeTarget('postgres:///tm?host=/var/run/postgresql&port=5433')).toEqual({ host: '/var/run/postgresql', port: 5433, database: 'tm' });
  });

  it('rejects what is not a postgres URL', () => {
    expect(() => describeTarget('mysql://x/y')).toThrow(/postgres:\/\//);
    expect(() => describeTarget('tm_scale')).toThrow(/not a URL/);
  });
});

describe('decide', () => {
  const scratch = { host: '127.0.0.1', port: 5544, database: 'tm_scale' };
  const dev = { ...scratch, port: 5433, database: 'tracemap' };
  const empty: TargetFacts = { marker: null, tablesWithData: [] };
  const foreign: TargetFacts = { marker: null, tablesWithData: ['services', 'svc_rollup_1m'] };
  const marker = (state: Marker['state'], error: string | null = null): TargetFacts => ({
    marker: { state, startedAt: '2026-11-17T08:00:00.000Z', finishedAt: null, error },
    tablesWithData: ['services'],
  });
  const flags = (o: Partial<GuardOpts> = {}): GuardOpts => ({ reset: false, yes: false, force: false, ...o });

  it('seeds an empty database with --yes, or after a prompt on a terminal', () => {
    expect(decide(scratch, empty, flags({ yes: true }), false)).toEqual({ action: 'proceed' });
    expect(decide(scratch, empty, flags(), true)).toEqual({ action: 'confirm' });
  });

  it('refuses without --yes when there is no terminal to ask on', () => {
    const d = decide(scratch, empty, flags(), false);
    expect(d.action).toBe('refuse');
    expect(d.action === 'refuse' && d.reason).toMatch(/--yes/);
    expect(d.action === 'refuse' && d.reason).toMatch(/"tm_scale" on 127\.0\.0\.1:5544/);
  });

  it('refuses the dev port unless --force', () => {
    const d = decide(dev, empty, flags({ yes: true }), true);
    expect(d.action).toBe('refuse');
    expect(d.action === 'refuse' && d.reason).toMatch(/5433/);
    expect(decide(dev, empty, flags({ yes: true, force: true }), false)).toEqual({ action: 'proceed' });
  });

  it('refuses the dev port before connecting', () => {
    expect(beforeConnect(dev, flags({ yes: true }))?.action).toBe('refuse');
    expect(beforeConnect(dev, flags({ force: true }))).toBeNull();
    expect(beforeConnect(scratch, flags())).toBeNull();
  });

  it('refuses data the harness did not write, even with --reset --yes, unless --force', () => {
    for (const o of [{ yes: true }, { reset: true, yes: true }]) {
      const d = decide(scratch, foreign, flags(o), true);
      expect(d.action).toBe('refuse');
      expect(d.action === 'refuse' && d.reason).toMatch(/did not write \(services, svc_rollup_1m\)/);
    }
    expect(decide(scratch, foreign, flags({ yes: true, force: true }), false)).toEqual({ action: 'proceed' });
  });

  it('re-seeds its own complete database', () => {
    expect(decide(scratch, marker('complete'), flags({ yes: true }), false)).toEqual({ action: 'proceed' });
  });

  it('calls a failed or unfinished seed half-seeded and requires --reset', () => {
    for (const facts of [marker('failed', 'seed worker 3: connection reset'), marker('running')]) {
      const d = decide(scratch, facts, flags({ yes: true }), true);
      expect(d.action).toBe('refuse');
      expect(d.action === 'refuse' && d.reason).toMatch(/half-seeded.*--reset --yes/);
      // --force does not paper over it either: the rows are inconsistent.
      expect(decide(scratch, facts, flags({ yes: true, force: true }), true).action).toBe('refuse');
      expect(decide(scratch, facts, flags({ reset: true, yes: true }), false)).toEqual({ action: 'proceed' });
    }
    const d = decide(scratch, marker('failed', 'seed worker 3: connection reset'), flags({ yes: true }), true);
    expect(d.action === 'refuse' && d.reason).toMatch(/connection reset/);
  });

  it('keeps requiring --yes for --reset, terminal or not', () => {
    for (const interactive of [true, false]) {
      const d = decide(scratch, marker('complete'), flags({ reset: true }), interactive);
      expect(d.action).toBe('refuse');
      expect(d.action === 'refuse' && d.reason).toMatch(/--reset.*--yes/);
    }
  });
});

describe('dataTables', () => {
  it('covers the catalog, every rollup tier and the kept traces', () => {
    const t = dataTables();
    expect(t).toContain('services');
    expect(t).toContain('svc_rollup_1m');
    expect(t).toContain('edge_error_rollup_1d');
    expect(t).toContain('kept_traces');
    expect(t).toHaveLength(1 + 6 * 4 + 1);
  });
});
