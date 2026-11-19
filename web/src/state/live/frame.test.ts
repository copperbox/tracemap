import { describe, expect, it } from 'vitest';
import { decodeFrame, FRAME_MAGIC, frameByteLength, FrameError } from './frame';

/** Build a frame by hand, byte by byte, straight from the contract layout. */
function handFrame(): ArrayBuffer {
  const nS = 2;
  const nE = 1;
  const buf = new ArrayBuffer(32 + (nS + nE) * 20 + nS + nE);
  const v = new DataView(buf);
  v.setUint32(0, 0x544d4c31, true);
  v.setUint32(4, 42, true); // seq
  v.setUint32(8, 7, true); // structureVersion
  v.setUint32(12, nS, true);
  v.setUint32(16, nE, true);
  v.setUint32(20, 0, true);
  v.setFloat64(24, Date.UTC(2026, 10, 17, 12, 0, 0), true);
  const vals = [
    [12.5, 3, 9, 20, 0.5],
    [0, NaN, NaN, NaN, NaN],
    [4, 1.5, 2.5, 8, 50],
  ];
  let off = 32;
  for (const row of vals) for (const x of row) (v.setFloat32(off, x, true), (off += 4));
  v.setUint8(off++, 0b000); // ok, live
  v.setUint8(off++, 0b101); // crit (2 << 1), stale
  v.setUint8(off++, 0b010); // warn
  return buf;
}

describe('decodeFrame', () => {
  it('reads the header, the value blocks and the flag bytes', () => {
    const f = decodeFrame(handFrame());
    expect(f.seq).toBe(42);
    expect(f.structureVersion).toBe(7);
    expect(f.nServices).toBe(2);
    expect(f.nEdges).toBe(1);
    expect(new Date(f.generatedAtMs).toISOString()).toBe('2026-11-17T12:00:00.000Z');
    expect(Array.from(f.services.slice(0, 5))).toEqual([12.5, 3, 9, 20, 0.5]);
    expect(f.services[5]).toBe(0);
    expect(Number.isNaN(f.services[6])).toBe(true);
    expect(Array.from(f.edges)).toEqual([4, 1.5, 2.5, 8, 50]);
    expect(Array.from(f.serviceFlags)).toEqual([0b000, 0b101]);
    expect(Array.from(f.edgeFlags)).toEqual([0b010]);
  });

  it('rejects a bad magic', () => {
    const buf = handFrame();
    new DataView(buf).setUint32(0, 0xdeadbeef, true);
    expect(() => decodeFrame(buf)).toThrow(FrameError);
  });

  it('rejects a truncated or padded frame', () => {
    expect(() => decodeFrame(handFrame().slice(0, 50))).toThrow(/expected/);
    expect(() => decodeFrame(new ArrayBuffer(10))).toThrow(/too short/);
    const padded = new Uint8Array(frameByteLength(2, 1) + 4);
    padded.set(new Uint8Array(handFrame()));
    expect(() => decodeFrame(padded.buffer)).toThrow(/expected/);
  });

  it('accepts an empty frame', () => {
    const buf = new ArrayBuffer(32);
    new DataView(buf).setUint32(0, FRAME_MAGIC, true);
    const f = decodeFrame(buf);
    expect(f.nServices).toBe(0);
    expect(f.services.length).toBe(0);
  });
});
