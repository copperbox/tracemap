/**
 * Binary metrics frame for the live map, little-endian:
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
 *
 * Index i is the i-th service (edge) of the LiveStructure with the same version.
 */

export const FRAME_MAGIC = 0x544d4c31;
export const FRAME_HEADER_BYTES = 32;
export const FIELDS = 5;

export type Status = 'ok' | 'warn' | 'crit';

export interface FrameMetrics {
  rps: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  errPct: number;
  stale: boolean;
  status: Status;
}

export interface Frame {
  seq: number;
  structureVersion: number;
  generatedAtMs: number;
  services: FrameMetrics[];
  edges: FrameMetrics[];
}

const STATUS_CODE: Record<Status, number> = { ok: 0, warn: 1, crit: 2 };
const STATUS_NAME: Status[] = ['ok', 'warn', 'crit'];

export function frameBytes(nServices: number, nEdges: number): number {
  return FRAME_HEADER_BYTES + (nServices + nEdges) * FIELDS * 4 + nServices + nEdges;
}

const f = (v: number | null): number => (v == null ? NaN : v);

export function encodeFrame(frame: Frame): Buffer {
  const ns = frame.services.length;
  const ne = frame.edges.length;
  const buf = Buffer.alloc(frameBytes(ns, ne));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint32(0, FRAME_MAGIC, true);
  dv.setUint32(4, frame.seq >>> 0, true);
  dv.setUint32(8, frame.structureVersion >>> 0, true);
  dv.setUint32(12, ns, true);
  dv.setUint32(16, ne, true);
  dv.setUint32(20, 0, true);
  dv.setFloat64(24, frame.generatedAtMs, true);
  let off = FRAME_HEADER_BYTES;
  for (const list of [frame.services, frame.edges]) {
    for (const m of list) {
      dv.setFloat32(off, m.rps, true);
      dv.setFloat32(off + 4, f(m.p50), true);
      dv.setFloat32(off + 8, f(m.p95), true);
      dv.setFloat32(off + 12, f(m.p99), true);
      dv.setFloat32(off + 16, m.errPct, true);
      off += FIELDS * 4;
    }
  }
  for (const list of [frame.services, frame.edges]) {
    for (const m of list) buf[off++] = (m.stale ? 1 : 0) | (STATUS_CODE[m.status] << 1);
  }
  return buf;
}

const n = (v: number): number | null => (Number.isNaN(v) ? null : v);

/** Inverse of encodeFrame (values come back as f32). Used by tests and the harness. */
export function decodeFrame(buf: Uint8Array): Frame {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== FRAME_MAGIC) throw new Error('bad frame magic');
  const ns = dv.getUint32(12, true);
  const ne = dv.getUint32(16, true);
  if (buf.byteLength !== frameBytes(ns, ne)) throw new Error('bad frame length');
  let off = FRAME_HEADER_BYTES;
  const read = (count: number): FrameMetrics[] => {
    const out: FrameMetrics[] = [];
    for (let i = 0; i < count; i++) {
      out.push({
        rps: dv.getFloat32(off, true),
        p50: n(dv.getFloat32(off + 4, true)),
        p95: n(dv.getFloat32(off + 8, true)),
        p99: n(dv.getFloat32(off + 12, true)),
        errPct: dv.getFloat32(off + 16, true),
        stale: false,
        status: 'ok',
      });
      off += FIELDS * 4;
    }
    return out;
  };
  const services = read(ns);
  const edges = read(ne);
  for (const m of [...services, ...edges]) {
    const flags = buf[off++];
    m.stale = (flags & 1) === 1;
    m.status = STATUS_NAME[(flags >> 1) & 3] ?? 'ok';
  }
  return {
    seq: dv.getUint32(4, true),
    structureVersion: dv.getUint32(8, true),
    generatedAtMs: dv.getFloat64(24, true),
    services,
    edges,
  };
}
