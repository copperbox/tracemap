import { describe, expect, it } from 'vitest';
import { exportPayload, toAnyValue } from './payload.js';
import type { SimSpan } from './trace.js';
import { byId } from './topology.js';

describe('toAnyValue', () => {
  it('encodes integers as intValue strings', () => {
    expect(toAnyValue(200)).toEqual({ intValue: '200' });
  });

  it('encodes non-integers as doubleValue', () => {
    expect(toAnyValue(1.5)).toEqual({ doubleValue: 1.5 });
  });

  it('encodes strings as stringValue', () => {
    expect(toAnyValue('GET')).toEqual({ stringValue: 'GET' });
  });
});

describe('exportPayload', () => {
  const span = (over: Partial<SimSpan>): SimSpan => ({
    service: byId.get('orders-svc')!,
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    name: 'GET /v1/orders/{id}',
    kind: 2,
    startNs: 1_700_000_000_000_000_000n,
    endNs: 1_700_000_000_120_000_000n,
    isError: false,
    attrs: { 'http.request.method': 'GET', 'http.response.status_code': 200 },
    ...over,
  });

  it('groups spans into one resourceSpans entry per service', () => {
    const spans = [
      span({}),
      span({ service: byId.get('pg-orders')!, spanId: 'c'.repeat(16), kind: 3 }),
      span({ spanId: 'd'.repeat(16) }),
    ];
    const payload = exportPayload('a'.repeat(32), spans) as {
      resourceSpans: { scopeSpans: { spans: unknown[] }[] }[];
    };
    expect(payload.resourceSpans).toHaveLength(2);
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
    expect(payload.resourceSpans[1].scopeSpans[0].spans).toHaveLength(1);
  });

  it('emits the resource attributes the collector keys on', () => {
    const payload = exportPayload('a'.repeat(32), [span({})]) as {
      resourceSpans: { resource: { attributes: { key: string; value: unknown }[] } }[];
    };
    const attrs = Object.fromEntries(
      payload.resourceSpans[0].resource.attributes.map((a) => [a.key, a.value]),
    );
    expect(attrs['service.name']).toEqual({ stringValue: 'orders-svc' });
    expect(attrs['team.name']).toEqual({ stringValue: 'Checkout' });
    expect(attrs['telemetry.sdk.language']).toEqual({ stringValue: 'go' });
    expect(attrs['telemetry.sdk.name']).toEqual({ stringValue: 'opentelemetry' });
  });

  it('falls back to unknown sdk language for uninstrumented peers', () => {
    const payload = exportPayload('a'.repeat(32), [span({ service: byId.get('pg-orders')! })]) as {
      resourceSpans: { resource: { attributes: { key: string; value: { stringValue: string } }[] } }[];
    };
    const lang = payload.resourceSpans[0].resource.attributes.find(
      (a) => a.key === 'telemetry.sdk.language',
    );
    expect(lang?.value).toEqual({ stringValue: 'unknown' });
  });

  it('encodes span fields the way an OTel SDK would', () => {
    const payload = exportPayload('a'.repeat(32), [span({})]) as {
      resourceSpans: { scopeSpans: { scope: unknown; spans: Record<string, unknown>[] }[] }[];
    };
    const scopeSpan = payload.resourceSpans[0].scopeSpans[0];
    expect(scopeSpan.scope).toEqual({ name: 'tracemap-sim', version: '1.0.0' });
    const s = scopeSpan.spans[0];
    expect(s.traceId).toBe('a'.repeat(32));
    expect(s.spanId).toBe('b'.repeat(16));
    expect(s.parentSpanId).toBeUndefined();
    expect(s.startTimeUnixNano).toBe('1700000000000000000');
    expect(s.endTimeUnixNano).toBe('1700000000120000000');
    expect(s.attributes).toEqual([
      { key: 'http.request.method', value: { stringValue: 'GET' } },
      { key: 'http.response.status_code', value: { intValue: '200' } },
    ]);
    expect(s.status).toEqual({ code: 0 });
  });

  it('marks failed spans with an error status', () => {
    const payload = exportPayload('a'.repeat(32), [span({ isError: true })]) as {
      resourceSpans: { scopeSpans: { spans: { status: unknown }[] }[] }[];
    };
    expect(payload.resourceSpans[0].scopeSpans[0].spans[0].status).toEqual({
      code: 2,
      message: 'simulated failure',
    });
  });
});
