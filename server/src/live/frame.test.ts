import { describe, expect, it } from 'vitest';
import { FRAME_MAGIC, decodeFrame, encodeFrame, frameBytes, quantizeF32, type Frame, type FrameMetrics } from './frame.js';

// What a reader gets back for a written value.
const f32 = quantizeF32;

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

  it('quantizes every value to within 2^-12 relative error and keeps NaN, 0, tiny and huge values', () => {
    const values: number[] = [0, -0, 1, 0.5, 3.1, 40.2, 99.99, 1e-30, 1.5e-38, 3e38, 1e30, 186_000, 12_345.678, 7.000_001];
    for (let i = 0; i < 2000; i++) values.push(Math.exp((Math.random() - 0.5) * 60));
    const metric = (v: number): FrameMetrics => ({ rps: v, p50: v, p95: v, p99: null, errPct: v, stale: false, status: 'ok' });
    const back = decodeFrame(encodeFrame({ seq: 1, structureVersion: 1, generatedAtMs: 0, services: values.map(metric), edges: [] }));
    back.services.forEach((m, i) => {
      const v = values[i];
      for (const got of [m.rps, m.p50!, m.p95!, m.errPct]) {
        if (v === 0) expect(got).toBe(v);
        else expect(Math.abs(got - v) / v).toBeLessThanOrEqual(2 ** -12 + 2 ** -23);
      }
      expect(m.p99).toBeNull();
    });
    // The low 12 mantissa bits of every written f32 are zero.
    const buf = encodeFrame({ seq: 1, structureVersion: 1, generatedAtMs: 0, services: values.map(metric), edges: [] });
    for (let off = 32; off < 32 + values.length * 20; off += 4) expect(buf.readUInt32LE(off) & 0xfff).toBe(0);
  });

  it('keeps NaN (including NaNs with only low mantissa bits) and infinities', () => {
    const lowNaN = new Float32Array(new Uint32Array([0x7f80_0001]).buffer)[0];
    expect(Number.isNaN(lowNaN)).toBe(true);
    expect(Number.isNaN(quantizeF32(lowNaN))).toBe(true);
    expect(Number.isNaN(quantizeF32(NaN))).toBe(true);
    expect(quantizeF32(Infinity)).toBe(Infinity);
    expect(quantizeF32(-Infinity)).toBe(-Infinity);
    // The largest f32 would round up to Infinity; it is truncated instead.
    expect(Number.isFinite(quantizeF32(3.4028234663852886e38))).toBe(true);
    const back = decodeFrame(
      encodeFrame({ seq: 1, structureVersion: 1, generatedAtMs: 0, services: [{ rps: NaN, p50: null, p95: NaN, p99: 0, errPct: 0, stale: true, status: 'ok' }], edges: [] }),
    );
    expect(back.services[0]).toMatchObject({ p50: null, p95: null, p99: 0, errPct: 0 });
    expect(Number.isNaN(back.services[0].rps)).toBe(true);
  });

  it('handles an empty fleet and rejects a foreign buffer', () => {
    const empty = encodeFrame({ seq: 1, structureVersion: 2, generatedAtMs: 3, services: [], edges: [] });
    expect(empty.length).toBe(32);
    expect(decodeFrame(empty)).toEqual({ seq: 1, structureVersion: 2, generatedAtMs: 3, services: [], edges: [] });
    expect(() => decodeFrame(Buffer.alloc(32))).toThrow(/magic/);
    expect(() => decodeFrame(encodeFrame(frame).subarray(0, 40))).toThrow(/length/);
  });
});
