/**
 * Decoder for the binary live metrics frame (GET /api/live/metrics).
 * Little-endian layout:
 *
 *   0   u32  magic 0x544D4C31
 *   4   u32  seq
 *   8   u32  structureVersion
 *   12  u32  nServices
 *   16  u32  nEdges
 *   20  u32  0
 *   24  f64  generatedAtMs
 *   32  f32[nServices * 5]   rps, p50, p95, p99, errPct   (NaN = null)
 *   ..  f32[nEdges * 5]      same five
 *   ..  u8[nServices]        bit0 stale, bits1-2 status (0 ok, 1 warn, 2 crit)
 *   ..  u8[nEdges]           same
 */

export const FRAME_MAGIC = 0x544d4c31;
export const FRAME_HEADER_BYTES = 32;
/** Values per entity: rps, p50, p95, p99, errPct. */
export const FRAME_FIELDS = 5;

export interface MetricsFrame {
  seq: number;
  structureVersion: number;
  nServices: number;
  nEdges: number;
  generatedAtMs: number;
  /** nServices * 5 values; NaN means null. */
  services: Float32Array;
  edges: Float32Array;
  serviceFlags: Uint8Array;
  edgeFlags: Uint8Array;
}

export class FrameError extends Error {}

export function frameByteLength(nServices: number, nEdges: number): number {
  return FRAME_HEADER_BYTES + (nServices + nEdges) * (FRAME_FIELDS * 4 + 1);
}

const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function f32s(view: DataView, offset: number, count: number): Float32Array {
  // Every f32 block starts on a 4-byte boundary (32 + 20 * n), so a view
  // straight onto the buffer works on little-endian hosts with no copy.
  if (LITTLE_ENDIAN_HOST) return new Float32Array(view.buffer, view.byteOffset + offset, count);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getFloat32(offset + i * 4, true);
  return out;
}

/** Decode and validate a frame's header and length. Throws FrameError. */
export function decodeFrame(buf: ArrayBuffer): MetricsFrame {
  if (buf.byteLength < FRAME_HEADER_BYTES) throw new FrameError(`frame too short: ${buf.byteLength} bytes`);
  const v = new DataView(buf);
  const magic = v.getUint32(0, true);
  if (magic !== FRAME_MAGIC) throw new FrameError(`bad frame magic 0x${magic.toString(16)}`);
  const nServices = v.getUint32(12, true);
  const nEdges = v.getUint32(16, true);
  const want = frameByteLength(nServices, nEdges);
  if (buf.byteLength !== want) {
    throw new FrameError(`frame is ${buf.byteLength} bytes, expected ${want} for ${nServices}/${nEdges}`);
  }
  const svcOff = FRAME_HEADER_BYTES;
  const edgeOff = svcOff + nServices * FRAME_FIELDS * 4;
  const svcFlagOff = edgeOff + nEdges * FRAME_FIELDS * 4;
  const edgeFlagOff = svcFlagOff + nServices;
  return {
    seq: v.getUint32(4, true),
    structureVersion: v.getUint32(8, true),
    nServices,
    nEdges,
    generatedAtMs: v.getFloat64(24, true),
    services: f32s(v, svcOff, nServices * FRAME_FIELDS),
    edges: f32s(v, edgeOff, nEdges * FRAME_FIELDS),
    serviceFlags: new Uint8Array(buf, svcFlagOff, nServices),
    edgeFlags: new Uint8Array(buf, edgeFlagOff, nEdges),
  };
}

/** Test and mock helper: build a frame from plain values (null -> NaN). */
export function encodeFrame(f: {
  seq: number;
  structureVersion: number;
  generatedAtMs: number;
  services: { values: (number | null)[]; flags: number }[];
  edges: { values: (number | null)[]; flags: number }[];
}): ArrayBuffer {
  const nS = f.services.length;
  const nE = f.edges.length;
  const buf = new ArrayBuffer(frameByteLength(nS, nE));
  const v = new DataView(buf);
  v.setUint32(0, FRAME_MAGIC, true);
  v.setUint32(4, f.seq, true);
  v.setUint32(8, f.structureVersion, true);
  v.setUint32(12, nS, true);
  v.setUint32(16, nE, true);
  v.setUint32(20, 0, true);
  v.setFloat64(24, f.generatedAtMs, true);
  let off = FRAME_HEADER_BYTES;
  for (const e of [...f.services, ...f.edges]) {
    for (let k = 0; k < FRAME_FIELDS; k++) {
      v.setFloat32(off, e.values[k] ?? NaN, true);
      off += 4;
    }
  }
  for (const e of [...f.services, ...f.edges]) v.setUint8(off++, e.flags);
  return buf;
}
