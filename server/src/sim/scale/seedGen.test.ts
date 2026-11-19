import { describe, expect, it } from 'vitest';
import { HIST_BUCKETS, quantile } from '../../rollup/hist.js';
import { finalThrough1m } from '../../rollup/compact.js';
import { buildFleet } from './fleet.js';
import { calibrate, incidentWindows, type IncidentWindow } from './model.js';
import { genNode, planSeed, type RowSink } from './seedGen.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('planSeed', () => {
  const now = Date.parse('2026-11-17T09:07:31Z');
  const plan = planSeed({ nowMs: now, days: 7, recentMinutes: 120, graceMinutes: 3, flushMs: 10_000, tracesPerSec: 100 });

  it('puts the watermarks where compaction would be', () => {
    expect(new Date(plan.anchorMs).toISOString()).toBe('2026-11-17T09:07:00.000Z');
    expect(plan.c10).toBeLessThanOrEqual(finalThrough1m(now, 3, 10_000));
    expect(plan.c10 % (10 * MIN)).toBe(0);
    expect(new Date(plan.c10).toISOString()).toBe('2026-11-17T09:00:00.000Z');
    expect(new Date(plan.c1h).toISOString()).toBe('2026-11-17T09:00:00.000Z');
    expect(new Date(plan.c1d).toISOString()).toBe('2026-11-17T00:00:00.000Z');
    expect(plan.startMs).toBe(plan.c1d - 7 * DAY);
  });

  it('covers everything after the 10m watermark with 1m rows', () => {
    expect(plan.m0).toBeLessThanOrEqual(plan.c10);
    expect(new Date(plan.m0).toISOString()).toBe('2026-11-17T07:00:00.000Z');
  });
});

describe('genNode', () => {
  const fleet = buildFleet({ services: 120, teams: 4, seed: 3 });
  const calib = calibrate(fleet, 5000);
  const now = Date.parse('2026-11-17T09:07:31Z');
  const plan = planSeed({ nowMs: now, days: 2, recentMinutes: 60, graceMinutes: 3, flushMs: 10_000, tracesPerSec: 50 });
  const incidents = new Map<number, IncidentWindow[]>();
  for (const w of incidentWindows(fleet, plan.anchorMs)) incidents.set(w.node, [...(incidents.get(w.node) ?? []), w]);

  type Row = { table: string; bucket: number; key: string; n: number; err: number };
  const rows: Row[] = [];
  /** Histograms of the red kinds, by table|bucket|key (copied: the generator reuses its arrays). */
  const hists = new Map<string, Float64Array>();
  const sink: RowSink = {
    row: (kind, tier, bucket, keys, n, err, _sum, hist) => {
      rows.push({ table: `${kind}_${tier}`, bucket, key: keys.join('|'), n, err });
      if (hist) hists.set(`${kind}_${tier}|${bucket}|${keys.join('|')}`, Float64Array.from(hist));
    },
  };
  const ctx = { fleet, calib, plan, incidents };
  for (const n of fleet.nodes) genNode(ctx, n.idx, sink);

  const sumBy = (table: string, grain: number) => {
    const m = new Map<string, { n: number; err: number }>();
    for (const r of rows) {
      if (r.table !== table) continue;
      const k = `${Math.floor(r.bucket / grain) * grain}|${r.key}`;
      const v = m.get(k) ?? { n: 0, err: 0 };
      v.n += r.n;
      v.err += r.err;
      m.set(k, v);
    }
    return m;
  };
  const exact = (table: string) => {
    const m = new Map<string, { n: number; err: number }>();
    for (const r of rows) if (r.table === table) m.set(`${r.bucket}|${r.key}`, { n: r.n, err: r.err });
    return m;
  };

  it('writes every tier for every kind', () => {
    const tables = new Set(rows.map((r) => r.table));
    for (const k of ['svc_rollup', 'op_rollup', 'edge_rollup', 'edge_op_rollup', 'svc_error_rollup', 'edge_error_rollup']) {
      for (const t of ['1m', '10m', '1h', '1d']) expect(tables, `${k}_${t}`).toContain(`${k}_${t}`);
    }
  });

  it('builds 1h from 10m and 1d from 1h exactly', () => {
    for (const kind of ['svc_rollup', 'edge_rollup', 'svc_error_rollup']) {
      const tenByHour = sumBy(`${kind}_10m`, HOUR);
      for (const [k, v] of exact(`${kind}_1h`)) expect(tenByHour.get(k), k).toEqual(v);
      const hourByDay = sumBy(`${kind}_1h`, DAY);
      for (const [k, v] of exact(`${kind}_1d`)) expect(hourByDay.get(k), k).toEqual(v);
    }
  });

  it('builds the 1h histogram as the merge of its 10m histograms', () => {
    let checked = 0;
    for (const [k, h] of hists) {
      if (!k.startsWith('svc_rollup_1h|')) continue;
      const [, b, ...key] = k.split('|');
      const merged = new Float64Array(HIST_BUCKETS);
      for (let m = 0; m < 6; m++) {
        const ten = hists.get(`svc_rollup_10m|${Number(b) + m * 10 * MIN}|${key.join('|')}`);
        if (ten) for (let i = 0; i < HIST_BUCKETS; i++) merged[i] += ten[i];
      }
      expect(Array.from(merged)).toEqual(Array.from(h));
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  /** p95 over every svc_rollup row of a tier in [from, to). */
  const fleetP95 = (tier: string, from: number, to: number) => {
    const h = new Float64Array(HIST_BUCKETS);
    for (const [k, v] of hists) {
      const [table, b] = k.split('|');
      if (table !== `svc_rollup_${tier}` || Number(b) < from || Number(b) >= to) continue;
      for (let i = 0; i < HIST_BUCKETS; i++) h[i] += v[i];
    }
    return quantile(h, 0.95);
  };

  it('makes latency rise with traffic through the day', () => {
    // 2026-11-16 is a Monday: peak at 15:00 UTC, low at 03:00.
    const peak = fleetP95('1h', Date.parse('2026-11-16T14:00:00Z'), Date.parse('2026-11-16T16:00:00Z'));
    const low = fleetP95('1h', Date.parse('2026-11-16T02:00:00Z'), Date.parse('2026-11-16T04:00:00Z'));
    expect(peak / low).toBeGreaterThan(1.25);
  });

  it('gives each service a p95 that moves from bucket to bucket', () => {
    const svc = fleet.nodes.find((n) => n.instrumented && n.type === 'service')!;
    const p95s = new Set<number>();
    for (const [k, v] of hists) {
      const [table, , id] = k.split('|');
      if (table === 'svc_rollup_10m' && id === svc.id) p95s.add(quantile(v, 0.95));
    }
    expect(p95s.size).toBeGreaterThan(5);
  });

  it('raises latency into a node during its incidents', () => {
    let checked = 0;
    for (const w of incidentWindows(fleet, plan.anchorMs)) {
      const first = Math.ceil(w.startMs / (10 * MIN)) * 10 * MIN;
      if (w.endMs - first < 10 * MIN || first - DAY < plan.startMs || first + 10 * MIN > plan.c10) continue;
      const target = fleet.nodes[w.node].id;
      const p95At = (b: number) => {
        const h = new Float64Array(HIST_BUCKETS);
        for (const [k, v] of hists) {
          const [table, bucket, , t] = k.split('|');
          if (table === 'edge_rollup_10m' && Number(bucket) === b && t === target) for (let i = 0; i < HIST_BUCKETS; i++) h[i] += v[i];
        }
        return quantile(h, 0.95);
      };
      // Same time of day, one day earlier, so the daily curve cancels out.
      expect(p95At(first) / p95At(first - DAY), `${target} ${w.kind}`).toBeGreaterThan(1.15);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('builds 10m from 1m where 1m rows exist', () => {
    const oneByTen = sumBy('op_rollup_1m', 10 * MIN);
    let checked = 0;
    for (const r of rows) {
      if (r.table !== 'op_rollup_10m' || r.bucket < plan.m0) continue;
      expect(oneByTen.get(`${r.bucket}|${r.key}`)).toEqual({ n: r.n, err: r.err });
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('sums operations into the service row', () => {
    const ops = new Map<string, number>();
    for (const r of rows) if (r.table === 'op_rollup_10m') ops.set(`${r.bucket}|${r.key.split('|')[0]}`, (ops.get(`${r.bucket}|${r.key.split('|')[0]}`) ?? 0) + r.n);
    for (const r of rows) if (r.table === 'svc_rollup_10m') expect(ops.get(`${r.bucket}|${r.key}`)).toBe(r.n);
  });

  it('writes no coarse row at or past its watermark and no 1m row in the future', () => {
    // Plain comparisons: an expect() per row takes seconds over this many rows.
    const limit: Record<string, number> = { '10m': plan.c10, '1h': plan.c1h, '1d': plan.c1d, '1m': plan.anchorMs };
    const bad = rows.filter((r) => {
      const tier = r.table.slice(r.table.lastIndexOf('_') + 1);
      return !(r.bucket < limit[tier]) || (tier === '1m' && r.bucket < plan.m0);
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('is repeatable: the same plan writes the same rows', () => {
    const again: Row[] = [];
    const n = fleet.nodes[5].idx;
    genNode(ctx, n, { row: (kind, tier, bucket, keys, nn, err) => again.push({ table: `${kind}_${tier}`, bucket, key: keys.join('|'), n: nn, err }) });
    const first: Row[] = [];
    genNode(ctx, n, { row: (kind, tier, bucket, keys, nn, err) => first.push({ table: `${kind}_${tier}`, bucket, key: keys.join('|'), n: nn, err }) });
    expect(again).toEqual(first);
  });

  it('shows the chronic failures in the error ratio', () => {
    const crit = fleet.nodes.find((n) => n.health === 'crit')!;
    const day = rows.filter((r) => r.table === 'svc_rollup_1d' && r.key === crit.id);
    expect(day.length).toBeGreaterThan(0);
    const ratio = day.reduce((a, r) => a + r.err, 0) / day.reduce((a, r) => a + r.n, 0);
    expect(ratio).toBeGreaterThan(0.02);
  });
});
