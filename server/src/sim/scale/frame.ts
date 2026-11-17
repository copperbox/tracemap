/**
 * Decoder and checks for the live metrics frame (GET /api/live/metrics), per
 * the wire contract in the scale-rebuild brief:
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
 * Little-endian throughout.
 */

export const FRAME_MAGIC = 0x544d4c31;
export const FRAME_HEADER_BYTES = 32;
const FIELDS = 5;

export interface MetricsFrame {
  seq: number;
  structureVersion: number;
  nServices: number;
  nEdges: number;
  generatedAtMs: number;
  /** nServices * 5 values: rps, p50, p95, p99, errPct. */
  services: Float32Array;
  edges: Float32Array;
  serviceFlags: Uint8Array;
  edgeFlags: Uint8Array;
}

export function frameBytes(nServices: number, nEdges: number): number {
  return FRAME_HEADER_BYTES + (nServices + nEdges) * FIELDS * 4 + nServices + nEdges;
}

export function decodeFrame(buf: Uint8Array): MetricsFrame {
  if (buf.length < FRAME_HEADER_BYTES) throw new Error(`frame too short: ${buf.length} bytes`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== FRAME_MAGIC) throw new Error(`bad frame magic 0x${magic.toString(16)}`);
  const nServices = dv.getUint32(12, true);
  const nEdges = dv.getUint32(16, true);
  const want = frameBytes(nServices, nEdges);
  if (buf.length !== want) throw new Error(`frame is ${buf.length} bytes, expected ${want} for ${nServices} services and ${nEdges} edges`);
  // Copy the float sections: the source offset may not be 4-byte aligned.
  const floats = (offset: number, count: number): Float32Array => {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = dv.getFloat32(offset + i * 4, true);
    return out;
  };
  let off = FRAME_HEADER_BYTES;
  const services = floats(off, nServices * FIELDS);
  off += nServices * FIELDS * 4;
  const edges = floats(off, nEdges * FIELDS);
  off += nEdges * FIELDS * 4;
  const serviceFlags = buf.slice(off, off + nServices);
  off += nServices;
  const edgeFlags = buf.slice(off, off + nEdges);
  return {
    seq: dv.getUint32(4, true),
    structureVersion: dv.getUint32(8, true),
    nServices,
    nEdges,
    generatedAtMs: dv.getFloat64(24, true),
    services,
    edges,
    serviceFlags,
    edgeFlags,
  };
}

export interface FlagCounts {
  ok: number;
  warn: number;
  crit: number;
  stale: number;
  /** Entities whose rps is NaN (no data). */
  noData: number;
}

export function countFlags(flags: Uint8Array, values: Float32Array): FlagCounts {
  const c: FlagCounts = { ok: 0, warn: 0, crit: 0, stale: 0, noData: 0 };
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f & 1) c.stale++;
    const st = (f >> 1) & 3;
    if (st === 2) c.crit++;
    else if (st === 1) c.warn++;
    else c.ok++;
    if (Number.isNaN(values[i * FIELDS])) c.noData++;
  }
  return c;
}

export interface FrameCheck {
  ok: boolean;
  problems: string[];
  services: FlagCounts;
  edges: FlagCounts;
}

/** Check a frame against the structure it claims to describe. */
export function checkFrame(frame: MetricsFrame, structure: { version: number; services: unknown[]; edges: unknown[] }): FrameCheck {
  const problems: string[] = [];
  if (frame.structureVersion !== structure.version) {
    problems.push(`frame structureVersion ${frame.structureVersion} != structure version ${structure.version}`);
  }
  if (frame.nServices !== structure.services.length) problems.push(`frame has ${frame.nServices} services, structure ${structure.services.length}`);
  if (frame.nEdges !== structure.edges.length) problems.push(`frame has ${frame.nEdges} edges, structure ${structure.edges.length}`);
  for (const [name, flags] of [['service', frame.serviceFlags], ['edge', frame.edgeFlags]] as const) {
    for (let i = 0; i < flags.length; i++) {
      if (((flags[i] >> 1) & 3) === 3 || flags[i] >> 3) {
        problems.push(`${name} ${i} has invalid flags 0x${flags[i].toString(16)}`);
        break;
      }
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    services: countFlags(frame.serviceFlags, frame.services),
    edges: countFlags(frame.edgeFlags, frame.edges),
  };
}

// ---- server-sent events ----

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Incremental text/event-stream parser. feed() takes raw chunks and returns
 * complete events; comment lines (heartbeats) are counted in `comments`.
 */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  comments = 0;

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.search(/\r\n|\n|\r/)) >= 0) {
      const line = this.buffer.slice(0, nl);
      const sepLen = this.buffer.startsWith('\r\n', nl) ? 2 : 1;
      this.buffer = this.buffer.slice(nl + sepLen);
      if (line === '') {
        if (this.data.length || this.event) out.push({ event: this.event || 'message', data: this.data.join('\n') });
        this.event = '';
        this.data = [];
      } else if (line.startsWith(':')) {
        this.comments++;
      } else {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') this.event = value;
        else if (field === 'data') this.data.push(value);
      }
    }
    return out;
  }
}
