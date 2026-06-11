import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { anyValueToJs, decodeTraces, kvListToObject } from './decode.js';

const PROTO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'proto');

const JSON_EXPORT = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'orders-svc' } },
          { key: 'telemetry.sdk.language', value: { stringValue: 'go' } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: 'test' },
          spans: [
            {
              traceId: 'a'.repeat(32),
              spanId: 'b'.repeat(16),
              name: 'GET /v1/orders/{id}',
              kind: 2,
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000000120000000',
              attributes: [
                { key: 'http.response.status_code', value: { intValue: '200' } },
                { key: 'http.route', value: { stringValue: '/v1/orders/{id}' } },
              ],
              status: { code: 0 },
            },
            {
              traceId: 'a'.repeat(32),
              spanId: 'c'.repeat(16),
              parentSpanId: 'b'.repeat(16),
              name: 'SELECT orders',
              kind: 3,
              startTimeUnixNano: '1700000000010000000',
              endTimeUnixNano: '1700000000020000000',
              attributes: [{ key: 'db.system', value: { stringValue: 'postgresql' } }],
              status: { code: 'STATUS_CODE_ERROR' },
            },
          ],
        },
      ],
    },
  ],
};

describe('decodeTraces (OTLP/JSON)', () => {
  it('normalizes spans, ids, enums, timestamps and attributes', async () => {
    const out = await decodeTraces(Buffer.from(JSON.stringify(JSON_EXPORT)), 'application/json');
    expect(out).toHaveLength(1);
    expect(out[0].serviceName).toBe('orders-svc');
    expect(out[0].resourceAttrs['telemetry.sdk.language']).toBe('go');
    const [server, client] = out[0].spans;
    expect(server.traceId).toBe('a'.repeat(32));
    expect(server.parentSpanId).toBeNull();
    expect(server.kind).toBe(2);
    expect(server.statusCode).toBe(0);
    expect(server.attrs['http.response.status_code']).toBe(200);
    expect(Number(server.endUnixNano - server.startUnixNano) / 1e6).toBeCloseTo(120);
    expect(client.parentSpanId).toBe('b'.repeat(16));
    expect(client.statusCode).toBe(2); // string enum accepted
    expect(client.attrs['db.system']).toBe('postgresql');
  });
});

describe('decodeTraces (OTLP/protobuf)', () => {
  it('round-trips a protobuf-encoded export request', async () => {
    const root = new protobuf.Root();
    root.resolvePath = (_o, t) => (path.isAbsolute(t) ? t : path.join(PROTO_DIR, t));
    await root.load(['opentelemetry/proto/collector/trace/v1/trace_service.proto']);
    const Req = root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest');

    const msg = Req.fromObject({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'payments-svc' } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: Buffer.from('11'.repeat(16), 'hex'),
                  spanId: Buffer.from('22'.repeat(8), 'hex'),
                  name: 'POST /v1/intents',
                  kind: 2,
                  startTimeUnixNano: '1700000000000000000',
                  endTimeUnixNano: '1700000000050000000',
                  status: { code: 2 },
                },
              ],
            },
          ],
        },
      ],
    });
    const buf = Buffer.from(Req.encode(msg).finish());
    const out = await decodeTraces(buf, 'application/x-protobuf');
    expect(out[0].serviceName).toBe('payments-svc');
    const span = out[0].spans[0];
    expect(span.traceId).toBe('11'.repeat(16));
    expect(span.spanId).toBe('22'.repeat(8));
    expect(span.statusCode).toBe(2);
    expect(span.kind).toBe(2);
  });
});

describe('attribute conversion', () => {
  it('converts AnyValue variants', () => {
    expect(anyValueToJs({ stringValue: 'x' })).toBe('x');
    expect(anyValueToJs({ intValue: '42' })).toBe(42);
    expect(anyValueToJs({ doubleValue: 1.5 })).toBe(1.5);
    expect(anyValueToJs({ boolValue: true })).toBe(true);
    expect(anyValueToJs({ arrayValue: { values: [{ intValue: 1 }, { stringValue: 'a' }] } })).toEqual([1, 'a']);
    expect(
      anyValueToJs({ kvlistValue: { values: [{ key: 'k', value: { stringValue: 'v' } }] } }),
    ).toEqual({ k: 'v' });
  });

  it('builds attribute objects from KeyValue lists', () => {
    expect(
      kvListToObject([
        { key: 'a', value: { intValue: 1 } },
        { key: 'b', value: { stringValue: 's' } },
      ]),
    ).toEqual({ a: 1, b: 's' });
  });
});
