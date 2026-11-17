import { describe, expect, it } from 'vitest';
import { FRAME_MAGIC, decodeFrame, encodeFrame, frameBytes, type Frame } from './frame.js';

const f32 = (v: number) => Math.fround(v);

describe('metrics frame', () => {
  const frame: Frame = {
    seq: 4_000_000_001,
    structureVersion: 1_794_000_123,
    generatedAtMs: 1_794_923_243_512.25,
    services: [
      { rps: 12.5, p50: 3.1, p95: 40.2, p99: 120.7, errPct: 0.5, stale: false, status: 'ok' },
      { rps: 0, p50: null, p95: null, p99: null, errPct: 0, stale: true, status: 'ok' },
      { rps: 1e6, p50: 0.01, p95: 1.5, p99: 186_000, errPct: 3.3, stale: true, status: 'crit' },
    ],
    edges: [{ rps: 7.25, p50: 1, p95: 2, p99: null, errPct: 1, stale: false, status: 'warn' }],
  };

  it('round-trips through the documented little-endian layout', () => {
    const buf = encodeFrame(frame);
    expect(buf.length).toBe(frameBytes(3, 1));
    expect(buf.length).toBe(32 + 4 * 5 * 4 + 4);
    expect(buf.readUInt32LE(0)).toBe(FRAME_MAGIC);
    expect(buf.readUInt32LE(4)).toBe(frame.seq);
    expect(buf.readUInt32LE(8)).toBe(frame.structureVersion);
    expect(buf.readUInt32LE(12)).toBe(3);
    expect(buf.readUInt32LE(16)).toBe(1);
    expect(buf.readUInt32LE(20)).toBe(0);
    expect(buf.readDoubleLE(24)).toBe(frame.generatedAtMs);
    // First service's p95 and the edge's error % sit where the layout says.
    expect(buf.readFloatLE(32 + 8)).toBe(f32(40.2));
    expect(buf.readFloatLE(32 + 3 * 20 + 16)).toBe(1);
    // Flag bytes: services then edges.
    expect([...buf.subarray(buf.length - 4)]).toEqual([0b000, 0b001, 0b101, 0b010]);

    const back = decodeFrame(buf);
    const want = {
      ...frame,
      services: frame.services.map((m) => ({
        ...m,
        rps: f32(m.rps),
        p50: m.p50 == null ? null : f32(m.p50),
        p95: m.p95 == null ? null : f32(m.p95),
        p99: m.p99 == null ? null : f32(m.p99),
        errPct: f32(m.errPct),
      })),
      edges: frame.edges.map((m) => ({ ...m, rps: f32(m.rps), p99: null })),
    };
    expect(back).toEqual(want);
  });

  it('encodes nulls as NaN', () => {
    const buf = encodeFrame(frame);
    expect(Number.isNaN(buf.readFloatLE(32 + 20 + 4))).toBe(true);
  });

  it('handles an empty fleet and rejects a foreign buffer', () => {
    const empty = encodeFrame({ seq: 1, structureVersion: 2, generatedAtMs: 3, services: [], edges: [] });
    expect(empty.length).toBe(32);
    expect(decodeFrame(empty)).toEqual({ seq: 1, structureVersion: 2, generatedAtMs: 3, services: [], edges: [] });
    expect(() => decodeFrame(Buffer.alloc(32))).toThrow(/magic/);
    expect(() => decodeFrame(encodeFrame(frame).subarray(0, 40))).toThrow(/length/);
  });
});
