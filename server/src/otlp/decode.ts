import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

const PROTO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'proto');

export interface NormalizedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number; // OTEL SpanKind 0..5
  startUnixNano: bigint;
  endUnixNano: bigint;
  statusCode: number; // 0 unset, 1 ok, 2 error
  attrs: Record<string, unknown>;
}

export interface NormalizedResourceSpans {
  serviceName: string | null;
  resourceAttrs: Record<string, unknown>;
  spans: NormalizedSpan[];
}

export interface NormalizedMetricPoint {
  serviceName: string | null;
  name: string;
  kind: 'gauge' | 'sum' | 'histogram';
  timeUnixNano: bigint;
  value: number | null;
  count: number | null;
  attrs: Record<string, unknown>;
}

let rootPromise: Promise<protobuf.Root> | null = null;

function loadRoot(): Promise<protobuf.Root> {
  if (!rootPromise) {
    const root = new protobuf.Root();
    root.resolvePath = (_origin, target) =>
      path.isAbsolute(target) ? target : path.join(PROTO_DIR, target);
    rootPromise = root.load([
      'opentelemetry/proto/collector/trace/v1/trace_service.proto',
      'opentelemetry/proto/collector/metrics/v1/metrics_service.proto',
    ]);
  }
  return rootPromise;
}

// ---- shared helpers ----

const SPAN_KIND_NAMES: Record<string, number> = {
  SPAN_KIND_UNSPECIFIED: 0,
  SPAN_KIND_INTERNAL: 1,
  SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3,
  SPAN_KIND_PRODUCER: 4,
  SPAN_KIND_CONSUMER: 5,
};
const STATUS_CODE_NAMES: Record<string, number> = {
  STATUS_CODE_UNSET: 0,
  STATUS_CODE_OK: 1,
  STATUS_CODE_ERROR: 2,
};

function toEnum(v: unknown, names: Record<string, number>): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return names[v] ?? (Number(v) || 0);
  return 0;
}

function toNano(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.round(v));
  if (typeof v === 'string' && v) return BigInt(v);
  if (v && typeof v === 'object' && 'toString' in v) return BigInt(String(v)); // protobufjs Long
  return 0n;
}

function idToHex(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') {
    // OTLP/JSON uses hex; protobufjs JSON may give base64. Heuristic: valid hex of even length stays.
    if (/^[0-9a-fA-F]*$/.test(v) && v.length % 2 === 0) return v.toLowerCase();
    return Buffer.from(v, 'base64').toString('hex');
  }
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  return '';
}

/** Convert OTLP AnyValue (proto-decoded object or OTLP/JSON object) to a plain JS value. */
export function anyValueToJs(v: unknown): unknown {
  if (v == null || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if ('stringValue' in o) return o.stringValue;
  if ('boolValue' in o) return o.boolValue;
  if ('intValue' in o) return typeof o.intValue === 'object' ? Number(String(o.intValue)) : Number(o.intValue);
  if ('doubleValue' in o) return Number(o.doubleValue);
  if ('arrayValue' in o) {
    const arr = (o.arrayValue as { values?: unknown[] })?.values ?? [];
    return arr.map(anyValueToJs);
  }
  if ('kvlistValue' in o) {
    const kvs = (o.kvlistValue as { values?: unknown[] })?.values ?? [];
    return kvListToObject(kvs);
  }
  if ('bytesValue' in o) return o.bytesValue;
  return null;
}

export function kvListToObject(kvs: unknown[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of kvs ?? []) {
    const { key, value } = kv as { key?: string; value?: unknown };
    if (key) out[key] = anyValueToJs(value);
  }
  return out;
}

// ---- traces ----

function normalizeTraceBody(body: Record<string, unknown>): NormalizedResourceSpans[] {
  const out: NormalizedResourceSpans[] = [];
  for (const rs of (body.resourceSpans as unknown[] | undefined) ?? []) {
    const r = rs as Record<string, unknown>;
    const resourceAttrs = kvListToObject((r.resource as { attributes?: unknown[] })?.attributes);
    const serviceName =
      typeof resourceAttrs['service.name'] === 'string' ? (resourceAttrs['service.name'] as string) : null;
    const spans: NormalizedSpan[] = [];
    for (const ss of (r.scopeSpans as unknown[] | undefined) ?? []) {
      for (const sp of ((ss as Record<string, unknown>).spans as unknown[] | undefined) ?? []) {
        const s = sp as Record<string, unknown>;
        const parent = idToHex(s.parentSpanId);
        spans.push({
          traceId: idToHex(s.traceId),
          spanId: idToHex(s.spanId),
          parentSpanId: parent || null,
          name: String(s.name ?? ''),
          kind: toEnum(s.kind, SPAN_KIND_NAMES),
          startUnixNano: toNano(s.startTimeUnixNano),
          endUnixNano: toNano(s.endTimeUnixNano),
          statusCode: toEnum((s.status as Record<string, unknown> | undefined)?.code, STATUS_CODE_NAMES),
          attrs: kvListToObject(s.attributes as unknown[] | undefined),
        });
      }
    }
    out.push({ serviceName, resourceAttrs, spans });
  }
  return out;
}

export async function decodeTraces(
  body: Buffer,
  contentType: string,
): Promise<NormalizedResourceSpans[]> {
  if (contentType.includes('json')) {
    return normalizeTraceBody(JSON.parse(body.toString('utf8')));
  }
  const root = await loadRoot();
  const Req = root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest');
  const msg = Req.decode(body);
  const obj = Req.toObject(msg, { longs: String, enums: Number, bytes: Buffer }) as Record<string, unknown>;
  return normalizeTraceBody(obj);
}

// ---- metrics ----

function normalizeMetricsBody(body: Record<string, unknown>): NormalizedMetricPoint[] {
  const out: NormalizedMetricPoint[] = [];
  for (const rm of (body.resourceMetrics as unknown[] | undefined) ?? []) {
    const r = rm as Record<string, unknown>;
    const resourceAttrs = kvListToObject((r.resource as { attributes?: unknown[] })?.attributes);
    const serviceName =
      typeof resourceAttrs['service.name'] === 'string' ? (resourceAttrs['service.name'] as string) : null;
    for (const sm of (r.scopeMetrics as unknown[] | undefined) ?? []) {
      for (const m of ((sm as Record<string, unknown>).metrics as unknown[] | undefined) ?? []) {
        const metric = m as Record<string, unknown>;
        const name = String(metric.name ?? '');
        const pushNumber = (kind: 'gauge' | 'sum', dps: unknown[] | undefined) => {
          for (const dp of dps ?? []) {
            const d = dp as Record<string, unknown>;
            const value =
              d.asDouble != null ? Number(d.asDouble) : d.asInt != null ? Number(String(d.asInt)) : null;
            out.push({
              serviceName,
              name,
              kind,
              timeUnixNano: toNano(d.timeUnixNano),
              value,
              count: null,
              attrs: kvListToObject(d.attributes as unknown[] | undefined),
            });
          }
        };
        if (metric.gauge) pushNumber('gauge', (metric.gauge as { dataPoints?: unknown[] }).dataPoints);
        if (metric.sum) pushNumber('sum', (metric.sum as { dataPoints?: unknown[] }).dataPoints);
        if (metric.histogram) {
          for (const dp of (metric.histogram as { dataPoints?: unknown[] }).dataPoints ?? []) {
            const d = dp as Record<string, unknown>;
            out.push({
              serviceName,
              name,
              kind: 'histogram',
              timeUnixNano: toNano(d.timeUnixNano),
              value: d.sum != null ? Number(d.sum) : null,
              count: d.count != null ? Number(String(d.count)) : null,
              attrs: kvListToObject(d.attributes as unknown[] | undefined),
            });
          }
        }
      }
    }
  }
  return out;
}

export async function decodeMetrics(
  body: Buffer,
  contentType: string,
): Promise<NormalizedMetricPoint[]> {
  if (contentType.includes('json')) {
    return normalizeMetricsBody(JSON.parse(body.toString('utf8')));
  }
  const root = await loadRoot();
  const Req = root.lookupType('opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest');
  const msg = Req.decode(body);
  const obj = Req.toObject(msg, { longs: String, enums: Number, bytes: Buffer }) as Record<string, unknown>;
  return normalizeMetricsBody(obj);
}

export async function encodeTraceResponse(): Promise<Buffer> {
  const root = await loadRoot();
  const Res = root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse');
  return Buffer.from(Res.encode(Res.create({})).finish());
}

export async function encodeMetricsResponse(): Promise<Buffer> {
  const root = await loadRoot();
  const Res = root.lookupType('opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceResponse');
  return Buffer.from(Res.encode(Res.create({})).finish());
}
