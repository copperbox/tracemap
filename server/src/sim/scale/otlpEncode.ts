/**
 * Hand-written OTLP/protobuf encoder for ExportTraceServiceRequest. The
 * protobufjs reflection path (fromObject + encode) tops out well below the
 * harness's target rate on one thread; this writes the wire format directly.
 * otlpEncode.test.ts decodes the output with the collector's own .proto files.
 *
 * Field numbers (opentelemetry/proto, v1):
 *   ExportTraceServiceRequest.resource_spans = 1
 *   ResourceSpans: resource = 1, scope_spans = 2
 *   Resource.attributes = 1
 *   ScopeSpans: scope = 1, spans = 2;  InstrumentationScope: name = 1, version = 2
 *   Span: trace_id = 1, span_id = 2, parent_span_id = 4, name = 5, kind = 6,
 *         start_time_unix_nano = 7 (fixed64), end_time_unix_nano = 8 (fixed64),
 *         attributes = 9, status = 15
 *   Status: message = 2, code = 3
 *   KeyValue: key = 1, value = 2;  AnyValue: string_value = 1, int_value = 3, double_value = 4
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;

export class PbWriter {
  buf: Buffer;
  pos = 0;
  private stack: number[] = [];

  constructor(size = 64 * 1024) {
    this.buf = Buffer.allocUnsafe(size);
  }

  reset(): void {
    this.pos = 0;
    this.stack.length = 0;
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    const next = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.pos + n));
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }

  /** Unsigned varint, exact up to 2^53. */
  varint(v: number): void {
    this.ensure(10);
    while (v >= 128) {
      this.buf[this.pos++] = (v % 128) | 128;
      v = Math.floor(v / 128);
    }
    this.buf[this.pos++] = v;
  }

  tag(field: number, wire: number): void {
    this.varint(field * 8 + wire);
  }

  uint(field: number, v: number): void {
    this.tag(field, WIRE_VARINT);
    this.varint(v);
  }

  string(field: number, s: string): void {
    const len = Buffer.byteLength(s);
    this.tag(field, WIRE_LEN);
    this.varint(len);
    this.ensure(len);
    this.pos += this.buf.write(s, this.pos, len, 'utf8');
  }

  bytes(field: number, src: Uint8Array, from = 0, len = src.length - from): void {
    this.tag(field, WIRE_LEN);
    this.varint(len);
    this.ensure(len);
    this.buf.set(src.subarray(from, from + len), this.pos);
    this.pos += len;
  }

  /** Copy already-encoded message fields verbatim. */
  raw(src: Uint8Array, from = 0, len = src.length - from): void {
    this.ensure(len);
    this.buf.set(src.subarray(from, from + len), this.pos);
    this.pos += len;
  }

  /** fixed64 from a non-negative integer held in a double (exact up to 2^53, close enough beyond). */
  fixed64(field: number, v: number): void {
    this.tag(field, WIRE_FIXED64);
    this.ensure(8);
    const hi = Math.floor(v / 4294967296);
    const lo = v - hi * 4294967296;
    this.buf.writeUInt32LE(lo >>> 0, this.pos);
    this.buf.writeUInt32LE(hi >>> 0, this.pos + 4);
    this.pos += 8;
  }

  double(field: number, v: number): void {
    this.tag(field, WIRE_FIXED64);
    this.ensure(8);
    this.buf.writeDoubleLE(v, this.pos);
    this.pos += 8;
  }

  /** Start a length-delimited submessage; close it with end(). */
  begin(field: number): void {
    this.tag(field, WIRE_LEN);
    this.ensure(1);
    this.stack.push(this.pos);
    this.pos += 1; // one length byte reserved; end() moves the body if it needs more
  }

  end(): void {
    const at = this.stack.pop()!;
    const len = this.pos - at - 1;
    let extra = 0;
    for (let v = len; v >= 128; v = Math.floor(v / 128)) extra++;
    if (extra) {
      this.ensure(extra);
      this.buf.copyWithin(at + 1 + extra, at + 1, this.pos);
      this.pos += extra;
    }
    let v = len;
    let p = at;
    while (v >= 128) {
      this.buf[p++] = (v % 128) | 128;
      v = Math.floor(v / 128);
    }
    this.buf[p] = v;
  }

  /** Attribute as KeyValue (field `field` of the enclosing message). */
  attr(field: number, key: string, value: string | number): void {
    this.begin(field);
    this.string(1, key);
    this.begin(2);
    if (typeof value === 'string') this.string(1, value);
    else if (Number.isInteger(value) && value >= 0) this.uint(3, value);
    else this.double(4, value);
    this.end();
    this.end();
  }

  finish(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.pos));
  }
}

/** Encoded Resource (field 1 of ResourceSpans) plus the scope header, cached per service. */
export function encodeResourceHeader(attrs: Record<string, string | number>, scopeName: string, scopeVersion: string): { resource: Buffer; scope: Buffer } {
  const w = new PbWriter(1024);
  w.begin(1);
  for (const [k, v] of Object.entries(attrs)) w.attr(1, k, v);
  w.end();
  const resource = w.finish();
  w.reset();
  w.begin(1);
  w.string(1, scopeName);
  w.string(2, scopeVersion);
  w.end();
  return { resource, scope: w.finish() };
}

export interface SpanFields {
  traceId: Uint8Array;
  spanId: Uint8Array;
  parentSpanId: Uint8Array | null;
  name: string;
  kind: number;
  startNs: number;
  endNs: number;
  attrs: [string, string | number][];
  /** 0 unset, 2 error. */
  statusCode: number;
  statusMessage: string;
}

/** Append one Span as field 2 of a ScopeSpans body being built in `w`. */
export function writeSpan(w: PbWriter, s: SpanFields): void {
  w.begin(2);
  w.bytes(1, s.traceId);
  w.bytes(2, s.spanId);
  if (s.parentSpanId) w.bytes(4, s.parentSpanId);
  w.string(5, s.name);
  w.uint(6, s.kind);
  w.fixed64(7, s.startNs);
  w.fixed64(8, s.endNs);
  for (const [k, v] of s.attrs) w.attr(9, k, v);
  if (s.statusCode) {
    w.begin(15);
    if (s.statusMessage) w.string(2, s.statusMessage);
    w.uint(3, s.statusCode);
    w.end();
  }
  w.end();
}

/**
 * Wrap per-service span bodies into one ExportTraceServiceRequest:
 * one ResourceSpans per service, one ScopeSpans each.
 */
export function encodeRequest(groups: { resource: Buffer; scope: Buffer; spans: PbWriter }[], out = new PbWriter()): Buffer {
  out.reset();
  for (const g of groups) {
    out.begin(1);
    out.raw(g.resource);
    out.begin(2);
    out.raw(g.scope);
    out.raw(g.spans.buf, 0, g.spans.pos);
    out.end();
    out.end();
  }
  return out.finish();
}
