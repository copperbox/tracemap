import { describe, expect, it } from 'vitest';
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
  const sink: RowSink = {
    row: (kind, tier, bucket, keys, n, err) => rows.push({ table: `${kind}_${tier}`, bucket, key: keys.join('|'), n, err }),
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
    for (const r of rows) {
      if (r.table.endsWith('_10m')) expect(r.bucket).toBeLessThan(plan.c10);
      if (r.table.endsWith('_1h')) expect(r.bucket).toBeLessThan(plan.c1h);
      if (r.table.endsWith('_1d')) expect(r.bucket).toBeLessThan(plan.c1d);
      if (r.table.endsWith('_1m')) {
        expect(r.bucket).toBeGreaterThanOrEqual(plan.m0);
        expect(r.bucket).toBeLessThan(plan.anchorMs);
      }
    }
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
